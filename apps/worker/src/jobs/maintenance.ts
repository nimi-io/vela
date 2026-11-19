import type { Job } from "bullmq";
import { getDb, uploads, assets, views, usageDaily, eq, and, lt, gte, isNull, sql } from "@vela/db";
import { storage, keys, finalizeUpload, emitEvent, uploadJson, createLogger } from "@vela/core";

const log = createLogger("worker:maintenance");

/** Detects finished direct uploads (works with any S3 provider, no bucket notifications needed). */
export async function sweepUploads(_job: Job) {
  const db = getDb();
  const now = new Date();
  const expired = await db
    .update(uploads)
    .set({ status: "timed_out" })
    .where(and(eq(uploads.status, "waiting"), lt(uploads.expiresAt, now)))
    .returning();
  for (const u of expired) {
    // A file may have landed just before expiry; prefer creating the asset.
    if (await storage.exists(u.storageKey)) {
      await db.update(uploads).set({ status: "waiting" }).where(eq(uploads.id, u.id));
      await finalizeUpload(u.id);
      continue;
    }
    await emitEvent(u.environmentId, "video.upload.cancelled", uploadJson(u), { type: "upload", id: u.id });
  }

  const waiting = await db.select({ id: uploads.id }).from(uploads).where(eq(uploads.status, "waiting")).limit(500);
  let created = 0;
  for (const u of waiting) {
    try {
      if (await finalizeUpload(u.id)) created++;
    } catch (err: any) {
      log.warn({ uploadId: u.id, err: err.message }, "finalize failed");
    }
  }
  return { checked: waiting.length, created, expired: expired.length };
}

/** Rolls delivered minutes and stored minutes into usage_daily (encoded minutes are added at encode time). */
export async function usageRollup(_job: Job) {
  const db = getDb();
  const day = new Date().toISOString().slice(0, 10);
  const start = new Date(`${day}T00:00:00Z`);
  const delivered = await db
    .select({ env: views.environmentId, seconds: sql<number>`coalesce(sum(${views.watchTimeMs}),0)::float / 1000` })
    .from(views)
    .where(gte(views.startedAt, start))
    .groupBy(views.environmentId);
  const stored = await db
    .select({ env: assets.environmentId, seconds: sql<number>`coalesce(sum(${assets.duration}),0)::float` })
    .from(assets)
    .where(and(isNull(assets.deletedAt), eq(assets.status, "ready")))
    .groupBy(assets.environmentId);
  const envs = new Set([...delivered.map((d) => d.env), ...stored.map((s) => s.env)]);
  for (const env of envs) {
    const d = delivered.find((x) => x.env === env)?.seconds ?? 0;
    const s = stored.find((x) => x.env === env)?.seconds ?? 0;
    await db
      .insert(usageDaily)
      .values({ environmentId: env, day, deliveredSeconds: d, storedSeconds: s })
      .onConflictDoUpdate({ target: [usageDaily.environmentId, usageDaily.day], set: { deliveredSeconds: d, storedSeconds: s } });
  }
  return { environments: envs.size };
}

/** Removes every stored object for a deleted asset. */
export async function deleteAssetFiles(job: Job<{ assetId: string }>) {
  const n = await storage.deletePrefix(keys.assetPrefix(job.data.assetId));
  return { deleted: n };
}
