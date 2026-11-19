import { Hono } from "hono";
import { z } from "zod";
import { getDb, uploads, eq, and, desc, sql } from "@vela/db";
import {
  newAssetSettingsSchema,
  uploadJson,
  randomId,
  storage,
  keys,
  finalizeUpload,
  emitEvent,
} from "@vela/core";
import { body, ok, notFound, pagination, ApiError } from "../lib/http.js";
import type { AppEnv } from "../types.js";

async function loadUpload(envId: string, id: string) {
  const [u] = await getDb()
    .select()
    .from(uploads)
    .where(and(eq(uploads.id, id), eq(uploads.environmentId, envId)));
  if (!u) notFound("Upload");
  return u;
}

export const uploadRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const db = getDb();
    const { limit, offset, page } = pagination(c);
    const where = eq(uploads.environmentId, c.get("environmentId"));
    const rows = await db.select().from(uploads).where(where).orderBy(desc(uploads.createdAt)).limit(limit).offset(offset);
    const [{ total }] = (await db.select({ total: sql<number>`count(*)::int` }).from(uploads).where(where)) as [
      { total: number },
    ];
    return c.json({ data: rows.map((u) => uploadJson(u)), pagination: { page, limit, total } });
  })

  /**
   * Direct upload: returns a presigned PUT URL. The client uploads the file straight to
   * storage; the asset is created when the object appears (POST /complete or the sweeper).
   */
  .post("/", async (c) => {
    const input = await body(
      c,
      z.object({
        cors_origin: z.string().max(500).optional(),
        new_asset_settings: newAssetSettingsSchema.omit({ input: true }).default({}),
        timeout: z.number().int().min(60).max(7 * 86400).default(3600),
        test: z.boolean().optional(),
      }),
    );
    const id = randomId(24);
    const storageKey = keys.uploadSource(id);
    const [u] = await getDb()
      .insert(uploads)
      .values({
        id,
        environmentId: c.get("environmentId"),
        corsOrigin: input.cors_origin,
        newAssetSettings: input.new_asset_settings,
        storageKey,
        timeoutSeconds: input.timeout,
        test: input.test ?? false,
        expiresAt: new Date(Date.now() + input.timeout * 1000),
      })
      .returning();
    const url = await storage.presignPut(storageKey, input.timeout);
    await emitEvent(u!.environmentId, "video.upload.created", uploadJson(u!), { type: "upload", id });
    return ok(c, uploadJson(u!, url), 201);
  })

  .get("/:id", async (c) => {
    const u = await loadUpload(c.get("environmentId"), c.req.param("id"));
    const url = u.status === "waiting" ? await storage.presignPut(u.storageKey, Math.max(60, Math.floor((u.expiresAt.getTime() - Date.now()) / 1000))) : undefined;
    return ok(c, uploadJson(u, url));
  })

  /** Tell the API the PUT finished so processing starts immediately (otherwise the sweeper finds it). */
  .post("/:id/complete", async (c) => {
    const u = await loadUpload(c.get("environmentId"), c.req.param("id"));
    if (u.status === "waiting") {
      const asset = await finalizeUpload(u.id);
      if (!asset) throw new ApiError(409, "upload_incomplete", "No file has been uploaded to this upload URL yet");
    }
    return ok(c, uploadJson(await loadUpload(u.environmentId, u.id)));
  })

  .put("/:id/cancel", async (c) => {
    const u = await loadUpload(c.get("environmentId"), c.req.param("id"));
    if (u.status !== "waiting") throw new ApiError(400, "invalid_request", `Upload is already ${u.status}`);
    const [x] = await getDb().update(uploads).set({ status: "cancelled" }).where(eq(uploads.id, u.id)).returning();
    await storage.deleteKey(u.storageKey).catch(() => {});
    await emitEvent(u.environmentId, "video.upload.cancelled", uploadJson(x!), { type: "upload", id: u.id });
    return ok(c, uploadJson(x!));
  });
