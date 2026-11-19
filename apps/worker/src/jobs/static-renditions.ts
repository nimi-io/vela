import fsp from "node:fs/promises";
import path from "node:path";
import type { Job } from "bullmq";
import { getDb, assets, eq, type StaticRendition } from "@vela/db";
import { env, storage, keys, emitEvent, loadAssetJson, randomId, createLogger, invalidateAssetPlayback } from "@vela/core";
import { ffmpeg, probe } from "../lib/media.js";
import { assetMaster } from "../lib/source.js";
import { cleanUpIfDeleted } from "../lib/deleted.js";

const log = createLogger("worker:static");

type Spec = { name: string; ext: "mp4" | "m4a"; maxHeight?: number; crf?: number };

function specsFor(mode: string): Spec[] {
  switch (mode) {
    case "capped-1080p":
      return [{ name: "capped-1080p", ext: "mp4", maxHeight: 1080, crf: 22 }];
    case "audio-only":
      return [{ name: "audio", ext: "m4a" }];
    case "standard":
      return [
        { name: "high", ext: "mp4", maxHeight: 1080, crf: 22 },
        { name: "medium", ext: "mp4", maxHeight: 720, crf: 24 },
        { name: "low", ext: "mp4", maxHeight: 480, crf: 26 },
        { name: "audio", ext: "m4a" },
      ];
    default:
      return [];
  }
}

/** Downloadable MP4/M4A files ("static renditions"). Not produced for DRM assets. */
export async function staticRenditions(job: Job<{ assetId: string }>) {
  const db = getDb();
  const [asset] = await db.select().from(assets).where(eq(assets.id, job.data.assetId));
  if (!asset || asset.deletedAt || asset.status !== "ready" || asset.protection === "drm") return { skipped: true };
  const specs = specsFor(asset.mp4Support);
  if (!specs.length) {
    await db.update(assets).set({ staticRenditions: [] }).where(eq(assets.id, asset.id));
    return { skipped: true };
  }

  const pending: StaticRendition[] = specs.map((s) => ({ name: `${s.name}.${s.ext}`, ext: s.ext, status: "preparing" }));
  await db.update(assets).set({ staticRenditions: pending }).where(eq(assets.id, asset.id));

  const work = path.join(env().WORK_DIR, `static-${asset.id}-${randomId(6)}`);
  await fsp.mkdir(work, { recursive: true });
  try {
    const src = path.join(work, "source");
    const trimArgs = await assetMaster(asset, src);
    const results: StaticRendition[] = [];
    for (const s of specs) {
      const out = path.join(work, `${s.name}.${s.ext}`);
      if (s.ext === "m4a") {
        await ffmpeg([...trimArgs, "-i", src, "-vn", "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart", out]);
      } else {
        const h = Math.min(s.maxHeight ?? 1080, asset.maxHeight ?? 1080, asset.maxWidth ?? 1920);
        const portrait = (asset.maxHeight ?? 0) > (asset.maxWidth ?? 0);
        const scale = portrait ? `scale=${h}:-2` : `scale=-2:${h}`;
        await ffmpeg([
          ...trimArgs,
          "-i",
          src,
          "-vf",
          `${scale},format=yuv420p`,
          "-c:v",
          "libx264",
          "-preset",
          env().X264_PRESET,
          "-crf",
          String(s.crf ?? 23),
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          "-movflags",
          "+faststart",
          out,
        ]);
      }
      const info = await probe(out);
      const stat = await fsp.stat(out);
      await storage.putFile(keys.assetStatic(asset.id, `${s.name}.${s.ext}`), out, s.ext === "mp4" ? "video/mp4" : "audio/mp4");
      results.push({
        name: `${s.name}.${s.ext}`,
        ext: s.ext,
        width: info.video?.width,
        height: info.video?.height,
        bitrate: info.bitrate,
        filesize: stat.size,
        status: "ready",
      });
      await fsp.rm(out, { force: true });
    }
    if (await cleanUpIfDeleted(asset.id)) return { skipped: true, deleted: true };
    await db.update(assets).set({ staticRenditions: results }).where(eq(assets.id, asset.id));
    await invalidateAssetPlayback(asset.id);
    await emitEvent(asset.environmentId, "video.asset.static_renditions.ready", (await loadAssetJson(asset.id))!, { type: "asset", id: asset.id });
    return { files: results.length };
  } catch (err: any) {
    log.error({ assetId: asset.id, err: err.message }, "static renditions failed");
    if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
      await db
        .update(assets)
        .set({ staticRenditions: pending.map((p) => ({ ...p, status: "errored" as const })) })
        .where(eq(assets.id, asset.id));
      await invalidateAssetPlayback(asset.id);
    }
    throw err;
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
