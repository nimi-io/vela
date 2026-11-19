import { Hono } from "hono";
import { getDb, liveStreams, simulcastTargets, playbackIds, eq } from "@vela/db";
import {
  env,
  safeEqual,
  createAsset,
  newAssetSettingsSchema,
  randomId,
  emitEvent,
  enqueue,
  liveStreamJson,
  createLogger,
} from "@vela/core";
import type { AppEnv } from "../types.js";

const log = createLogger("api:internal");

function checkSecret(provided: string | undefined) {
  const secret = env().INTERNAL_SECRET;
  return !!provided && safeEqual(provided, secret);
}

const keyFromPath = (path: string) => (path.startsWith("live/") ? path.slice(5) : path);

async function findByKey(key: string) {
  const [l] = await getDb().select().from(liveStreams).where(eq(liveStreams.streamKey, key));
  return l;
}

async function liveJson(id: string) {
  const db = getDb();
  const [l] = await db.select().from(liveStreams).where(eq(liveStreams.id, id));
  const pids = await db.select().from(playbackIds).where(eq(playbackIds.liveStreamId, id));
  const targets = await db.select().from(simulcastTargets).where(eq(simulcastTargets.liveStreamId, id));
  return liveStreamJson(l!, pids, targets);
}

/**
 * Endpoints called by MediaMTX. Not part of the public API — block /internal at your proxy
 * or keep the API on a private network for these.
 */
export const internalRoutes = new Hono<AppEnv>()
  /** MediaMTX external HTTP auth: decides who may publish/read. */
  .post("/mediamtx/auth", async (c) => {
    if (!checkSecret(c.req.query("secret"))) return c.body(null, 401);
    const req = (await c.req.json().catch(() => ({}))) as {
      user?: string;
      password?: string;
      action?: string;
      path?: string;
      query?: string;
      protocol?: string;
    };
    const internal = req.user === "internal" && !!req.password && safeEqual(req.password, env().INTERNAL_SECRET);
    if (internal) return c.body(null, 200);

    if (req.action === "publish" && req.path) {
      const stream = await findByKey(keyFromPath(req.path));
      if (stream && stream.status !== "disabled") return c.body(null, 200);
      log.warn({ path: req.path, protocol: req.protocol }, "rejected publish");
    }
    return c.body(null, 401);
  })

  /** Lifecycle hooks: ready (publisher connected), not_ready (disconnected), segment (recording chunk done). */
  .post("/live/hooks", async (c) => {
    if (!checkSecret(c.req.header("x-internal-secret"))) return c.body(null, 401);
    const form = await c.req.parseBody();
    const event = String(form.event ?? "");
    const path = String(form.path ?? "");
    const stream = await findByKey(keyFromPath(path));
    if (!stream) return c.json({ ok: false, reason: "unknown stream" }, 404);
    const db = getDb();
    const now = new Date();

    if (event === "ready") {
      if (stream.status === "disabled") return c.json({ ok: false });
      const withinWindow =
        !!stream.activeSessionId &&
        !!stream.lastDisconnectedAt &&
        now.getTime() - stream.lastDisconnectedAt.getTime() < stream.reconnectWindow * 1000;
      const sessionId = withinWindow ? stream.activeSessionId! : randomId(16);
      let activeAssetId = withinWindow ? stream.activeAssetId : null;

      if (!withinWindow && stream.recording) {
        const settings = newAssetSettingsSchema.parse(stream.newAssetSettings ?? {});
        const { asset } = await createAsset(
          stream.environmentId,
          { ...settings, input: undefined, title: settings.title ?? stream.title ?? undefined, passthrough: settings.passthrough ?? stream.passthrough ?? undefined },
          { liveStreamId: stream.id, isLive: true },
          { process: false },
        );
        activeAssetId = asset.id;
      }

      await db
        .update(liveStreams)
        .set({
          status: "active",
          connected: true,
          activeSessionId: sessionId,
          activeAssetId,
          lastActiveAt: now,
          health: { connected_at: now.toISOString(), protocol: String(form.protocol ?? "") || null },
          recentAssetIds:
            activeAssetId && !stream.recentAssetIds.includes(activeAssetId)
              ? [activeAssetId, ...stream.recentAssetIds].slice(0, 10)
              : stream.recentAssetIds,
        })
        .where(eq(liveStreams.id, stream.id));

      const json = await liveJson(stream.id);
      await emitEvent(stream.environmentId, "video.live_stream.connected", json, { type: "live_stream", id: stream.id });
      if (!withinWindow) {
        await emitEvent(stream.environmentId, "video.live_stream.active", json, { type: "live_stream", id: stream.id });
      }
      const targets = await db.select().from(simulcastTargets).where(eq(simulcastTargets.liveStreamId, stream.id));
      for (const t of targets) {
        await enqueue("live.simulcast", { liveStreamId: stream.id, targetId: t.id, sessionId }, { attempts: 1 });
      }
      return c.json({ ok: true, session_id: sessionId });
    }

    if (event === "not_ready") {
      await db
        .update(liveStreams)
        .set({ connected: false, lastDisconnectedAt: now })
        .where(eq(liveStreams.id, stream.id));
      await emitEvent(stream.environmentId, "video.live_stream.disconnected", await liveJson(stream.id), {
        type: "live_stream",
        id: stream.id,
      });
      if (stream.activeSessionId) {
        await enqueue(
          "live.finalize",
          { liveStreamId: stream.id, sessionId: stream.activeSessionId },
          { delay: stream.reconnectWindow * 1000 + 2000, jobId: `finalize-${stream.activeSessionId}-${now.getTime()}`, attempts: 3 },
        );
      }
      return c.json({ ok: true });
    }

    if (event === "segment") {
      const segmentPath = String(form.segment_path ?? "");
      if (!segmentPath || !stream.activeSessionId) return c.json({ ok: false });
      if (stream.recording) {
        await enqueue("live.segment", { liveStreamId: stream.id, sessionId: stream.activeSessionId, path: segmentPath });
      }
      return c.json({ ok: true });
    }

    return c.json({ ok: false, reason: "unknown event" }, 400);
  });
