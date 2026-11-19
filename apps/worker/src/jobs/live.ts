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
  getQueue,
  QUEUES,
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

const SEGMENT_JOB_STATES = ["active", "waiting", "delayed", "prioritized", "paused"] as const;

/**
 * Waits until every recording segment of the session has been uploaded: no live.segment job for
 * it is queued, running or waiting to retry, and the stored segment count is stable across one
 * poll (covering a segment hook that is still on its way from MediaMTX). Counting rows alone missed
 * a final segment whose upload was still running, which lost the end of the recording (or all of
 * it, with "no_recording", for sessions shorter than recordSegmentDuration).
 */
async function waitForSegmentUploads(sessionId: string, timeoutMs = 10 * 60_000) {
  const db = getDb();
  const queue = getQueue(QUEUES.live);
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    const jobs = await queue.getJobs([...SEGMENT_JOB_STATES]);
    const pending = jobs.some((j) => j?.name === "live.segment" && j.data?.sessionId === sessionId);
    const segs = await db.select({ id: liveSegments.id }).from(liveSegments).where(eq(liveSegments.sessionId, sessionId));
    if (!pending && segs.length === last) return;
    last = segs.length;
    await new Promise((r) => setTimeout(r, 3000));
  }
  log.warn({ sessionId }, "timed out waiting for recording segment uploads");
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

  // End the session first: an encoder that (re)connects from now on starts a new session instead
  // of joining the one being finalized. Segment jobs already queued carry their own session ID.
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

  await waitForSegmentUploads(job.data.sessionId);
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
