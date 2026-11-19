import { Hono } from "hono";
import { z } from "zod";
import {
  getDb,
  assets,
  playbackIds,
  tracks,
  eq,
  and,
  desc,
  isNull,
  inArray,
  ilike,
  or,
  sql,
} from "@vela/db";
import {
  createAsset,
  assertMp4SupportAllowed,
  DRM_MP4_MESSAGE,
  newAssetSettingsSchema,
  playbackPolicy,
  assetJson,
  playbackIdJson,
  trackJson,
  randomId,
  enqueue,
  emitEvent,
  storage,
  keys,
  publishInvalidation,
  assertPublicUrl,
  BlockedUrlError,
} from "@vela/core";
import { body, ok, notFound, pagination, ApiError, changes, hasChanges } from "../lib/http.js";
import { httpUrl } from "../lib/validators.js";
import type { AppEnv } from "../types.js";

async function loadAsset(envId: string, id: string) {
  const [a] = await getDb()
    .select()
    .from(assets)
    .where(and(eq(assets.id, id), eq(assets.environmentId, envId), isNull(assets.deletedAt)));
  if (!a) notFound("Asset");
  return a;
}

async function full(a: typeof assets.$inferSelect) {
  const db = getDb();
  const pids = await db.select().from(playbackIds).where(eq(playbackIds.assetId, a.id));
  const trks = await db.select().from(tracks).where(eq(tracks.assetId, a.id)).orderBy(tracks.createdAt);
  return assetJson(a, pids, trks);
}

export const assetRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const db = getDb();
    const envId = c.get("environmentId");
    const { limit, offset, page } = pagination(c);
    const conds = [eq(assets.environmentId, envId), isNull(assets.deletedAt)];
    const status = c.req.query("status");
    if (status) conds.push(eq(assets.status, status as any));
    const live = c.req.query("live_stream_id");
    if (live) conds.push(eq(assets.liveStreamId, live));
    const upload = c.req.query("upload_id");
    if (upload) conds.push(eq(assets.uploadId, upload));
    const q = c.req.query("q");
    if (q) conds.push(or(ilike(assets.title, `%${q}%`), ilike(assets.passthrough, `%${q}%`), eq(assets.id, q))!);

    const rows = await db
      .select()
      .from(assets)
      .where(and(...conds))
      .orderBy(desc(assets.createdAt))
      .limit(limit)
      .offset(offset);
    const [{ total }] = (await db
      .select({ total: sql<number>`count(*)::int` })
      .from(assets)
      .where(and(...conds))) as [{ total: number }];

    const ids = rows.map((r) => r.id);
    const pids = ids.length ? await db.select().from(playbackIds).where(inArray(playbackIds.assetId, ids)) : [];
    const trks = ids.length ? await db.select().from(tracks).where(inArray(tracks.assetId, ids)) : [];
    return c.json({
      data: rows.map((a) =>
        assetJson(
          a,
          pids.filter((p) => p.assetId === a.id),
          trks.filter((t) => t.assetId === a.id),
        ),
      ),
      pagination: { page, limit, total },
    });
  })

  .post("/", async (c) => {
    const input = await body(c, newAssetSettingsSchema);
    assertMp4SupportAllowed(input);
    const { asset, playbackIds: pids, tracks: trks } = await createAsset(c.get("environmentId"), input);
    return ok(c, assetJson(asset, pids, trks), 201);
  })

  .get("/:id", async (c) => ok(c, await full(await loadAsset(c.get("environmentId"), c.req.param("id")))))

  .patch("/:id", async (c) => {
    const a = await loadAsset(c.get("environmentId"), c.req.param("id"));
    const input = await body(
      c,
      z.object({ passthrough: z.string().max(255).nullable().optional(), title: z.string().max(512).nullable().optional() }),
    );
    const patch = changes(input);
    if (!hasChanges(patch)) return ok(c, await full(a));
    const [u] = await getDb().update(assets).set(patch).where(eq(assets.id, a.id)).returning();
    const json = await full(u!);
    await emitEvent(a.environmentId, "video.asset.updated", json, { type: "asset", id: a.id });
    return ok(c, json);
  })

  .delete("/:id", async (c) => {
    const a = await loadAsset(c.get("environmentId"), c.req.param("id"));
    const db = getDb();
    const json = await full(a);
    await db.update(assets).set({ deletedAt: new Date() }).where(eq(assets.id, a.id));
    const removed = await db.delete(playbackIds).where(eq(playbackIds.assetId, a.id)).returning({ id: playbackIds.id });
    await publishInvalidation({ playbackIds: removed.map((p) => p.id) });
    await enqueue("asset.delete", { assetId: a.id });
    await emitEvent(a.environmentId, "video.asset.deleted", json, { type: "asset", id: a.id });
    return c.body(null, 204);
  })

  .get("/:id/input-info", async (c) => {
    const a = await loadAsset(c.get("environmentId"), c.req.param("id"));
    return ok(c, { input: a.input, source: a.sourceMeta });
  })

  /** Temporary download link for the original file ("master access"). */
  .get("/:id/master", async (c) => {
    const a = await loadAsset(c.get("environmentId"), c.req.param("id"));
    const key = keys.assetSource(a.id);
    if (!(await storage.exists(key))) throw new ApiError(404, "not_found", "Master file is not available");
    const url = await storage.presignGet(key, 3600 * 24, { filename: `${a.id}-master` });
    return ok(c, { url, expires_in: 86400 });
  })

  /* --------------------------- Playback IDs --------------------------- */
  .post("/:id/playback-ids", async (c) => {
    const a = await loadAsset(c.get("environmentId"), c.req.param("id"));
    const input = await body(c, z.object({ policy: playbackPolicy.default("public") }));
    if (input.policy === "drm" && a.protection !== "drm") {
      throw new ApiError(400, "invalid_parameters", "DRM playback IDs require an asset created with the drm policy");
    }
    const [p] = await getDb()
      .insert(playbackIds)
      .values({ id: randomId(32), environmentId: a.environmentId, assetId: a.id, policy: input.policy })
      .returning();
    return ok(c, playbackIdJson(p!), 201);
  })

  .get("/:id/playback-ids/:pid", async (c) => {
    const a = await loadAsset(c.get("environmentId"), c.req.param("id"));
    const [p] = await getDb()
      .select()
      .from(playbackIds)
      .where(and(eq(playbackIds.id, c.req.param("pid")), eq(playbackIds.assetId, a.id)));
    if (!p) notFound("Playback ID");
    return ok(c, playbackIdJson(p));
  })

  .delete("/:id/playback-ids/:pid", async (c) => {
    const a = await loadAsset(c.get("environmentId"), c.req.param("id"));
    const res = await getDb()
      .delete(playbackIds)
      .where(and(eq(playbackIds.id, c.req.param("pid")), eq(playbackIds.assetId, a.id)))
      .returning();
    if (!res.length) notFound("Playback ID");
    await publishInvalidation({ playbackIds: res.map((p) => p.id) });
    return c.body(null, 204);
  })

  /* ------------------------------ MP4s ------------------------------ */
  .put("/:id/mp4-support", async (c) => {
    const a = await loadAsset(c.get("environmentId"), c.req.param("id"));
    const input = await body(c, z.object({ mp4_support: z.enum(["none", "capped-1080p", "audio-only", "standard"]) }));
    if (a.protection === "drm" && input.mp4_support !== "none") throw new ApiError(400, "invalid_parameters", DRM_MP4_MESSAGE);
    const db = getDb();
    const [u] = await db
      .update(assets)
      .set({ mp4Support: input.mp4_support, staticRenditions: [] })
      .where(eq(assets.id, a.id))
      .returning();
    // The stream service caches a ready asset for ~15 s. Without this, after enabling MP4s
    // it kept serving the old "mp4_support: none" row and answered 404 to the dashboard's
    // Download link (renditions for short videos finish well inside that window); after
    // disabling, it kept handing out downloads. Its short "settling" TTL takes over from here.
    const pids = await db.select({ id: playbackIds.id }).from(playbackIds).where(eq(playbackIds.assetId, a.id));
    await publishInvalidation({ playbackIds: pids.map((p) => p.id) });
    if (a.status === "ready") await enqueue("asset.static-renditions", { assetId: a.id });
    return ok(c, await full(u!));
  })

  /* ----------------------------- Tracks ----------------------------- */
  .post("/:id/tracks", async (c) => {
    const a = await loadAsset(c.get("environmentId"), c.req.param("id"));
    const input = await body(
      c,
      z.object({
        url: httpUrl,
        type: z.literal("text").default("text"),
        text_type: z.literal("subtitles").optional(),
        language_code: z.string().max(16).default("en"),
        name: z.string().max(200).optional(),
        closed_captions: z.boolean().optional(),
      }),
    );
    await assertPublicUrl(input.url).catch((err) => {
      throw err instanceof BlockedUrlError ? new ApiError(400, "invalid_parameters", `url: ${err.message}`) : err;
    });
    const [t] = await getDb()
      .insert(tracks)
      .values({
        id: randomId(24),
        assetId: a.id,
        type: input.type,
        textType: input.type === "text" ? "subtitles" : null,
        textSource: input.type === "text" ? "uploaded" : null,
        languageCode: input.language_code,
        name: input.name ?? input.language_code,
        closedCaptions: input.closed_captions ?? false,
        meta: { url: input.url },
      })
      .returning();
    await enqueue("track.ingest", { assetId: a.id, trackId: t!.id, url: input.url });
    await emitEvent(a.environmentId, "video.asset.track.created", { asset_id: a.id, ...trackJson(t!) }, { type: "track", id: t!.id });
    return ok(c, trackJson(t!), 201);
  })

  .delete("/:id/tracks/:tid", async (c) => {
    const a = await loadAsset(c.get("environmentId"), c.req.param("id"));
    const db = getDb();
    const [t] = await db.select().from(tracks).where(and(eq(tracks.id, c.req.param("tid")), eq(tracks.assetId, a.id)));
    if (!t) notFound("Track");
    if (t.type === "video") throw new ApiError(400, "invalid_request", "The video track can't be deleted");
    await db.delete(tracks).where(eq(tracks.id, t.id));
    if (t.storageKey) await storage.deleteKey(t.storageKey).catch(() => {});
    return c.body(null, 204);
  })

  /** Auto-generate subtitles from the audio (Whisper). */
  .post("/:id/generate-subtitles", async (c) => {
    const a = await loadAsset(c.get("environmentId"), c.req.param("id"));
    const input = await body(c, z.object({ language_code: z.string().max(16).default("en"), name: z.string().max(200).optional() }));
    const [t] = await getDb()
      .insert(tracks)
      .values({
        id: randomId(24),
        assetId: a.id,
        type: "text",
        textType: "subtitles",
        textSource: "generated",
        languageCode: input.language_code,
        name: input.name ?? `${input.language_code} (generated)`,
        closedCaptions: true,
      })
      .returning();
    if (a.status === "ready") await enqueue("track.generate-subtitles", { assetId: a.id, trackId: t!.id });
    return ok(c, trackJson(t!), 201);
  })

  /** Translate an existing text track into another language with an LLM. */
  .post("/:id/tracks/:tid/translate", async (c) => {
    const a = await loadAsset(c.get("environmentId"), c.req.param("id"));
    const input = await body(c, z.object({ language_code: z.string().max(16), name: z.string().max(200).optional() }));
    const db = getDb();
    const [src] = await db.select().from(tracks).where(and(eq(tracks.id, c.req.param("tid")), eq(tracks.assetId, a.id)));
    if (!src || src.type !== "text") notFound("Text track");
    if (src.status !== "ready") throw new ApiError(400, "invalid_request", "Source track is not ready yet");
    const [t] = await db
      .insert(tracks)
      .values({
        id: randomId(24),
        assetId: a.id,
        type: "text",
        textType: "subtitles",
        textSource: "translated",
        languageCode: input.language_code,
        name: input.name ?? `${input.language_code} (translated)`,
        closedCaptions: false,
        meta: { source_track_id: src.id },
      })
      .returning();
    await enqueue("track.translate", { assetId: a.id, trackId: t!.id, sourceTrackId: src.id });
    return ok(c, trackJson(t!), 201);
  })

  /** Summary, tags and chapters from the transcript. */
  .post("/:id/insights", async (c) => {
    const a = await loadAsset(c.get("environmentId"), c.req.param("id"));
    if (a.status !== "ready") throw new ApiError(400, "invalid_request", "Asset is not ready yet");
    await enqueue("asset.ai-insights", { assetId: a.id });
    return ok(c, { queued: true }, 201);
  })

  /** Create a new asset from a time range of this one. */
  .post("/:id/clips", async (c) => {
    const a = await loadAsset(c.get("environmentId"), c.req.param("id"));
    const input = await body(
      c,
      newAssetSettingsSchema.omit({ input: true }).extend({
        start_time: z.number().min(0),
        end_time: z.number().positive(),
      }),
    );
    if (input.end_time <= input.start_time) throw new ApiError(400, "invalid_parameters", "end_time must be after start_time");
    const { start_time, end_time, ...rest } = input;
    assertMp4SupportAllowed(rest);
    const policies = rest.playback_policies ?? rest.playback_policy ?? ["public"];
    const { asset, playbackIds: pids, tracks: trks } = await createAsset(a.environmentId, {
      ...rest,
      playback_policies: Array.isArray(policies) ? policies : [policies],
      title: rest.title ?? (a.title ? `${a.title} (clip)` : undefined),
      input: [{ url: `vela://assets/${a.id}`, start_time, end_time }],
    });
    return ok(c, assetJson(asset, pids, trks), 201);
  });
