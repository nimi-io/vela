import { Hono } from "hono";
import { z } from "zod";
import {
  getDb,
  liveStreams,
  playbackIds,
  simulcastTargets,
  eq,
  and,
  desc,
  inArray,
  sql,
} from "@vela/db";
import {
  liveStreamJson,
  playbackIdJson,
  simulcastJson,
  newAssetSettingsSchema,
  playbackPolicy,
  randomId,
  randomSecret,
  emitEvent,
  enqueue,
} from "@vela/core";
import { body, ok, notFound, pagination, ApiError } from "../lib/http.js";
import type { AppEnv } from "../types.js";

async function loadStream(envId: string, id: string) {
  const [l] = await getDb()
    .select()
    .from(liveStreams)
    .where(and(eq(liveStreams.id, id), eq(liveStreams.environmentId, envId)));
  if (!l) notFound("Live stream");
  return l;
}

async function full(l: typeof liveStreams.$inferSelect) {
  const db = getDb();
  const pids = await db.select().from(playbackIds).where(eq(playbackIds.liveStreamId, l.id));
  const targets = await db.select().from(simulcastTargets).where(eq(simulcastTargets.liveStreamId, l.id));
  return liveStreamJson(l, pids, targets);
}

const streamKey = () => randomSecret(18).replace(/[-_]/g, "x");

const simulcastInput = z.object({
  url: z.string().regex(/^rtmps?:\/\//, "must be an rtmp:// or rtmps:// URL"),
  stream_key: z.string().max(500).optional(),
  passthrough: z.string().max(255).optional(),
});

export const liveRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const db = getDb();
    const { limit, offset, page } = pagination(c);
    const where = eq(liveStreams.environmentId, c.get("environmentId"));
    const rows = await db.select().from(liveStreams).where(where).orderBy(desc(liveStreams.createdAt)).limit(limit).offset(offset);
    const ids = rows.map((r) => r.id);
    const pids = ids.length ? await db.select().from(playbackIds).where(inArray(playbackIds.liveStreamId, ids)) : [];
    const targets = ids.length ? await db.select().from(simulcastTargets).where(inArray(simulcastTargets.liveStreamId, ids)) : [];
    const [{ total }] = (await db.select({ total: sql<number>`count(*)::int` }).from(liveStreams).where(where)) as [
      { total: number },
    ];
    return c.json({
      data: rows.map((l) =>
        liveStreamJson(
          l,
          pids.filter((p) => p.liveStreamId === l.id),
          targets.filter((t) => t.liveStreamId === l.id),
        ),
      ),
      pagination: { page, limit, total },
    });
  })

  .post("/", async (c) => {
    const input = await body(
      c,
      z.object({
        playback_policy: z.union([playbackPolicy, z.array(playbackPolicy)]).optional(),
        playback_policies: z.array(playbackPolicy).optional(),
        new_asset_settings: newAssetSettingsSchema.omit({ input: true }).optional(),
        reconnect_window: z.number().int().min(0).max(1800).default(60),
        latency_mode: z.enum(["low", "reduced", "standard"]).default("low"),
        recording: z.boolean().default(true),
        passthrough: z.string().max(255).optional(),
        title: z.string().max(512).optional(),
        simulcast_targets: z.array(simulcastInput).max(10).optional(),
      }),
    );
    const db = getDb();
    const envId = c.get("environmentId");
    const id = randomId(24);
    const rawPolicies = input.playback_policies ?? input.playback_policy ?? ["public"];
    const policies = (Array.isArray(rawPolicies) ? rawPolicies : [rawPolicies]).filter((p) => p !== "drm");

    const [l] = await db
      .insert(liveStreams)
      .values({
        id,
        environmentId: envId,
        streamKey: streamKey(),
        reconnectWindow: input.reconnect_window,
        latencyMode: input.latency_mode,
        recording: input.recording,
        newAssetSettings: input.new_asset_settings ?? { playback_policies: policies },
        passthrough: input.passthrough,
        title: input.title,
      })
      .returning();
    for (const policy of policies) {
      await db.insert(playbackIds).values({ id: randomId(32), environmentId: envId, liveStreamId: id, policy });
    }
    for (const t of input.simulcast_targets ?? []) {
      await db.insert(simulcastTargets).values({ id: randomId(24), liveStreamId: id, url: t.url, streamKey: t.stream_key, passthrough: t.passthrough });
    }
    const json = await full(l!);
    await emitEvent(envId, "video.live_stream.created", json, { type: "live_stream", id });
    return ok(c, json, 201);
  })

  .get("/:id", async (c) => ok(c, await full(await loadStream(c.get("environmentId"), c.req.param("id")))))

  .patch("/:id", async (c) => {
    const l = await loadStream(c.get("environmentId"), c.req.param("id"));
    const input = await body(
      c,
      z.object({
        reconnect_window: z.number().int().min(0).max(1800).optional(),
        latency_mode: z.enum(["low", "reduced", "standard"]).optional(),
        recording: z.boolean().optional(),
        passthrough: z.string().max(255).nullable().optional(),
        title: z.string().max(512).nullable().optional(),
        new_asset_settings: newAssetSettingsSchema.omit({ input: true }).optional(),
      }),
    );
    const [u] = await getDb()
      .update(liveStreams)
      .set({
        reconnectWindow: input.reconnect_window,
        latencyMode: input.latency_mode,
        recording: input.recording,
        passthrough: input.passthrough,
        title: input.title,
        newAssetSettings: input.new_asset_settings,
      })
      .where(eq(liveStreams.id, l.id))
      .returning();
    return ok(c, await full(u!));
  })

  .delete("/:id", async (c) => {
    const l = await loadStream(c.get("environmentId"), c.req.param("id"));
    const json = await full(l);
    const db = getDb();
    await db.delete(playbackIds).where(eq(playbackIds.liveStreamId, l.id));
    await db.delete(liveStreams).where(eq(liveStreams.id, l.id));
    await emitEvent(l.environmentId, "video.live_stream.deleted", json, { type: "live_stream", id: l.id });
    return c.body(null, 204);
  })

  .post("/:id/reset-stream-key", async (c) => {
    const l = await loadStream(c.get("environmentId"), c.req.param("id"));
    const [u] = await getDb().update(liveStreams).set({ streamKey: streamKey() }).where(eq(liveStreams.id, l.id)).returning();
    return ok(c, await full(u!));
  })

  .put("/:id/disable", async (c) => {
    const l = await loadStream(c.get("environmentId"), c.req.param("id"));
    const [u] = await getDb().update(liveStreams).set({ status: "disabled" }).where(eq(liveStreams.id, l.id)).returning();
    if (l.activeSessionId) await enqueue("live.finalize", { liveStreamId: l.id, sessionId: l.activeSessionId });
    return ok(c, await full(u!));
  })

  .put("/:id/enable", async (c) => {
    const l = await loadStream(c.get("environmentId"), c.req.param("id"));
    if (l.status !== "disabled") return ok(c, await full(l));
    const [u] = await getDb().update(liveStreams).set({ status: "idle" }).where(eq(liveStreams.id, l.id)).returning();
    return ok(c, await full(u!));
  })

  /** End the current live session now instead of waiting for the reconnect window. */
  .put("/:id/complete", async (c) => {
    const l = await loadStream(c.get("environmentId"), c.req.param("id"));
    if (!l.activeSessionId) throw new ApiError(400, "invalid_request", "Live stream has no active session");
    await enqueue("live.finalize", { liveStreamId: l.id, sessionId: l.activeSessionId }, { jobId: `finalize-now-${l.activeSessionId}` });
    return ok(c, await full(l));
  })

  .post("/:id/playback-ids", async (c) => {
    const l = await loadStream(c.get("environmentId"), c.req.param("id"));
    const input = await body(c, z.object({ policy: z.enum(["public", "signed"]).default("public") }));
    const [p] = await getDb()
      .insert(playbackIds)
      .values({ id: randomId(32), environmentId: l.environmentId, liveStreamId: l.id, policy: input.policy })
      .returning();
    return ok(c, playbackIdJson(p!), 201);
  })

  .delete("/:id/playback-ids/:pid", async (c) => {
    const l = await loadStream(c.get("environmentId"), c.req.param("id"));
    const res = await getDb()
      .delete(playbackIds)
      .where(and(eq(playbackIds.id, c.req.param("pid")), eq(playbackIds.liveStreamId, l.id)))
      .returning();
    if (!res.length) notFound("Playback ID");
    return c.body(null, 204);
  })

  .post("/:id/simulcast-targets", async (c) => {
    const l = await loadStream(c.get("environmentId"), c.req.param("id"));
    const input = await body(c, simulcastInput);
    const [t] = await getDb()
      .insert(simulcastTargets)
      .values({ id: randomId(24), liveStreamId: l.id, url: input.url, streamKey: input.stream_key, passthrough: input.passthrough })
      .returning();
    if (l.connected && l.activeSessionId) {
      await enqueue("live.simulcast", { liveStreamId: l.id, targetId: t!.id, sessionId: l.activeSessionId });
    }
    return ok(c, simulcastJson(t!), 201);
  })

  .delete("/:id/simulcast-targets/:tid", async (c) => {
    const l = await loadStream(c.get("environmentId"), c.req.param("id"));
    const res = await getDb()
      .delete(simulcastTargets)
      .where(and(eq(simulcastTargets.id, c.req.param("tid")), eq(simulcastTargets.liveStreamId, l.id)))
      .returning();
    if (!res.length) notFound("Simulcast target");
    return c.body(null, 204);
  });
