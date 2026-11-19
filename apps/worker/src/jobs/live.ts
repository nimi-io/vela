import fsp from "node:fs/promises";
import path from "node:path";
import type { Job } from "bullmq";
import { getDb, liveStreams, liveSegments, simulcastTargets, assets, playbackIds, eq, and, asc } from "@vela/db";
import {
  env,
  storage,
  keys,
  emitEvent,
  enqueue,
  liveStreamJson,
  simulcastJson,
  loadAssetJson,
  randomId,
  createLogger,
} from "@vela/core";
import { ffmpeg } from "../lib/media.js";
import { run } from "../lib/exec.js";

const log = createLogger("worker:live");

/** Maps a path reported by MediaMTX to our mount of the shared recordings volume. */
function localRecordingPath(p: string) {
  const dir = env().RECORDINGS_DIR;
  if (p.startsWith(dir)) return p;
  const idx = p.indexOf("/live/");
  return idx >= 0 ? path.join(dir, p.slice(idx)) : path.join(dir, path.basename(p));
}

/** A finished recording segment from MediaMTX → object storage. */
export async function liveSegment(job: Job<{ liveStreamId: string; sessionId: string; path: string }>) {
  const file = localRecordingPath(job.data.path);
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat) {
    log.warn({ file }, "segment file not found (is the recordings volume shared with the worker?)");
    return { skipped: true };
  }
  const name = `${Date.now()}-${path.basename(file)}`;
  const key = keys.liveSegment(job.data.liveStreamId, job.data.sessionId, name);
  await storage.putFile(key, file, "video/mp4");
  await getDb().insert(liveSegments).values({ liveStreamId: job.data.liveStreamId, sessionId: job.data.sessionId, storageKey: key });
  // Best effort: MediaMTX also prunes recordings itself (recordDeleteAfter).
  await fsp.rm(file, { force: true }).catch(() => {});
  return { key };
}

async function streamJson(id: string) {
  const db = getDb();
  const [l] = await db.select().from(liveStreams).where(eq(liveStreams.id, id));
  if (!l) return null;
  const pids = await db.select().from(playbackIds).where(eq(playbackIds.liveStreamId, id));
  const targets = await db.select().from(simulcastTargets).where(eq(simulcastTargets.liveStreamId, id));
  return liveStreamJson(l, pids, targets);
}

/**
 * Runs after the reconnect window. Ends the session, stitches the recording into the live
 * asset's master file and hands it to the normal VOD pipeline.
 */
export async function liveFinalize(job: Job<{ liveStreamId: string; sessionId: string }>) {
  const db = getDb();
  const [stream] = await db.select().from(liveStreams).where(eq(liveStreams.id, job.data.liveStreamId));
  if (!stream || stream.activeSessionId !== job.data.sessionId) return { skipped: "stale" };
  const forced = String(job.id ?? "").startsWith("finalize-now-") || stream.status === "disabled";
  if (!forced) {
    if (stream.connected) return { skipped: "reconnected" };
    const sinceDisconnect = Date.now() - (stream.lastDisconnectedAt?.getTime() ?? 0);
    if (sinceDisconnect < stream.reconnectWindow * 1000) return { skipped: "newer disconnect pending" };
  }

  // Let in-flight segment uploads land.
  let last = -1;
  for (let i = 0; i < 10; i++) {
    const segs = await db.select().from(liveSegments).where(eq(liveSegments.sessionId, job.data.sessionId));
    if (segs.length === last) break;
    last = segs.length;
    await new Promise((r) => setTimeout(r, 3000));
  }

  const assetId = stream.activeAssetId;
  await db
    .update(liveStreams)
    .set({
      status: stream.status === "disabled" ? "disabled" : "idle",
      connected: false,
      activeSessionId: null,
      activeAssetId: null,
    })
    .where(eq(liveStreams.id, stream.id));
  const json = await streamJson(stream.id);
  if (json) await emitEvent(stream.environmentId, "video.live_stream.idle", json, { type: "live_stream", id: stream.id });

  if (!assetId) return { recorded: false };
  const segments = await db
    .select()
    .from(liveSegments)
    .where(and(eq(liveSegments.sessionId, job.data.sessionId), eq(liveSegments.liveStreamId, stream.id)))
    .orderBy(asc(liveSegments.id));
  if (!segments.length) {
    await db
      .update(assets)
      .set({ status: "errored", progress: null, errors: { type: "no_recording", messages: ["The live stream produced no recording"] } })
      .where(eq(assets.id, assetId));
    const aj = await loadAssetJson(assetId);
    if (aj) await emitEvent(stream.environmentId, "video.asset.errored", aj, { type: "asset", id: assetId });
    return { recorded: false };
  }

  const work = path.join(env().WORK_DIR, `live-${assetId}-${randomId(6)}`);
  await fsp.mkdir(work, { recursive: true });
  try {
    const list: string[] = [];
    for (const [i, s] of segments.entries()) {
      const f = path.join(work, `seg-${String(i).padStart(5, "0")}.mp4`);
      await storage.downloadToFile(s.storageKey, f);
      list.push(`file '${f}'`);
    }
    await fsp.writeFile(path.join(work, "list.txt"), list.join("\n"));
    const out = path.join(work, "recording.mp4");
    await ffmpeg(["-f", "concat", "-safe", "0", "-i", path.join(work, "list.txt"), "-c", "copy", "-movflags", "+faststart", out]);
    await storage.putFile(keys.assetSource(assetId), out, "video/mp4");
    await db.update(assets).set({ sourceKey: keys.assetSource(assetId) }).where(eq(assets.id, assetId));
    await enqueue("asset.process", { assetId }, { attempts: 2 });
    // Segments are no longer needed once the master exists.
    for (const s of segments) await storage.deleteKey(s.storageKey).catch(() => {});
    await db.delete(liveSegments).where(eq(liveSegments.sessionId, job.data.sessionId));
    return { recorded: true, segments: segments.length };
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** Restreams to an RTMP(S) destination (YouTube, Twitch, ...) for as long as the session lasts. */
export async function liveSimulcast(job: Job<{ liveStreamId: string; targetId: string; sessionId: string }>) {
  const db = getDb();
  const e = env();
  const setStatus = async (status: "starting" | "broadcasting" | "errored" | "idle") => {
    const [t] = await db.update(simulcastTargets).set({ status }).where(eq(simulcastTargets.id, job.data.targetId)).returning();
    return t;
  };

  for (let attempt = 0; attempt < 5; attempt++) {
    const [stream] = await db.select().from(liveStreams).where(eq(liveStreams.id, job.data.liveStreamId));
    const [target] = await db.select().from(simulcastTargets).where(eq(simulcastTargets.id, job.data.targetId));
    if (!stream || !target || !stream.connected || stream.activeSessionId !== job.data.sessionId) break;

    const src = `${e.MEDIAMTX_RTMP_URL}/live/${stream.streamKey}?user=internal&pass=${encodeURIComponent(e.INTERNAL_SECRET)}`;
    const dest = target.streamKey ? `${target.url.replace(/\/$/, "")}/${target.streamKey}` : target.url;
    await setStatus("starting");
    const started = Date.now();
    const timer = setTimeout(async () => {
      const t = await setStatus("broadcasting");
      if (t) await emitEvent(stream.environmentId, "video.live_stream.simulcast_target.broadcasting", { live_stream_id: stream.id, ...simulcastJson(t) });
    }, 5000);
    try {
      await run(e.FFMPEG_PATH, ["-hide_banner", "-nostdin", "-loglevel", "error", "-i", src, "-c", "copy", "-f", "flv", dest]);
      clearTimeout(timer);
      break; // source ended normally
    } catch (err: any) {
      clearTimeout(timer);
      log.warn({ target: target.id, err: err.message }, "simulcast ffmpeg exited");
      if (Date.now() - started < 5000 && attempt >= 2) {
        const t = await setStatus("errored");
        if (t) await emitEvent(stream.environmentId, "video.live_stream.simulcast_target.errored", { live_stream_id: stream.id, ...simulcastJson(t), error: err.message.slice(0, 300) });
        return { error: err.message };
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  await setStatus("idle");
  return { done: true };
}
