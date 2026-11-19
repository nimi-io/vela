import fsp from "node:fs/promises";
import path from "node:path";
import type { Job } from "bullmq";
import { getDb, assets, tracks, uploads, usageDaily, eq, and, sql, type Rendition } from "@vela/db";
import {
  env,
  storage,
  keys,
  buildLadder,
  resolutionTier,
  emitEvent,
  enqueue,
  loadAssetJson,
  getOrCreateContentKey,
  getDrmSettings,
  createLogger,
  randomId,
} from "@vela/core";
import { probe, aspectRatio } from "../lib/media.js";
import { transcode, poster, storyboard } from "../lib/transcode.js";
import { downloadUrl, downloadKey } from "../lib/source.js";

const log = createLogger("worker:process");

class InputError extends Error {}

export async function processAsset(job: Job<{ assetId: string }>) {
  const db = getDb();
  const { assetId } = job.data;
  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!asset || asset.deletedAt) return { skipped: true };
  if (asset.status === "ready") return { skipped: true };

  const work = path.join(env().WORK_DIR, `${assetId}-${randomId(6)}`);
  await fsp.mkdir(work, { recursive: true });

  let lastWrite = 0;
  const setProgress = async (state: string, progress: number, force = false) => {
    const now = Date.now();
    if (!force && now - lastWrite < 3000) return;
    lastWrite = now;
    await db.update(assets).set({ progress: { state, progress: Math.round(progress * 1000) / 10 } }).where(eq(assets.id, assetId));
    await job.updateProgress(Math.round(progress * 100));
  };

  try {
    /* 1. Get the source file locally (and keep a master copy in storage). */
    await setProgress("ingesting", 0, true);
    const source = path.join(work, "source");
    let trim: { start?: number; end?: number } | undefined;
    const primary = asset.input.find((i) => !i.type || i.type === "video");

    if (asset.sourceKey) {
      await downloadKey(asset.sourceKey, source);
      if (asset.sourceKey !== keys.assetSource(assetId)) {
        // Move a direct upload's object under the asset right away. Doing it only on success
        // left uploads/<id>/source behind forever for every upload that failed to process.
        await storage.copy(asset.sourceKey, keys.assetSource(assetId));
        await db.update(assets).set({ sourceKey: keys.assetSource(assetId) }).where(eq(assets.id, assetId));
        await storage.deleteKey(asset.sourceKey).catch(() => {});
      }
    } else if (primary?.url?.startsWith("vela://assets/")) {
      const srcId = primary.url.slice("vela://assets/".length);
      await downloadKey(keys.assetSource(srcId), source).catch(() => {
        throw new InputError("Source asset's master file is not available");
      });
      trim = { start: primary.start_time, end: primary.end_time };
    } else if (primary?.url) {
      await downloadUrl(primary.url, source).catch((e) => {
        throw new InputError(e.message);
      });
      trim = primary.start_time || primary.end_time ? { start: primary.start_time, end: primary.end_time } : undefined;
      await storage.putFile(keys.assetSource(assetId), source, "application/octet-stream");
    } else {
      throw new InputError("Asset has no input");
    }

    /* 2. Inspect it. */
    const info = await probe(source).catch(() => {
      throw new InputError("The input file could not be read as audio or video");
    });
    if (!info.video && !info.audio) throw new InputError("The input file has no audio or video streams");
    if (!info.duration || info.duration <= 0) throw new InputError("The input file has no duration");
    const end = Math.min(trim?.end ?? info.duration, info.duration);
    const start = Math.min(trim?.start ?? 0, end);
    const duration = end - start;
    if (duration <= 0.1) throw new InputError("Clip range is empty");

    const ladder = info.video
      ? buildLadder(
          { width: info.video.width, height: info.video.height, frameRate: info.video.frameRate, videoBitrate: info.video.bitrate ?? info.bitrate },
          { maxResolutionTier: asset.maxResolutionTier, videoQuality: asset.videoQuality },
        )
      : [];

    /* 3. Optional watermark overlay. */
    let overlay: { file: string; settings: any } | undefined;
    const overlayInput = asset.input.find((i) => i.overlay_settings && i.url);
    if (overlayInput && info.video) {
      const file = path.join(work, "overlay");
      await downloadUrl(overlayInput.url!, file).catch((e) => {
        throw new InputError(`Overlay image: ${e.message}`);
      });
      overlay = { file, settings: overlayInput.overlay_settings! };
    }

    /* 4. Keys for protected assets. */
    const out = path.join(work, "out", "hls");
    await fsp.mkdir(out, { recursive: true });
    let aesKey: { keyFile: string; ivHex: string } | undefined;
    let drm: { keyId: string; key: string; iv: string } | undefined;
    if (asset.protection === "aes-128") {
      const { key } = await getOrCreateContentKey(assetId);
      const keyFile = path.join(work, "enc.key");
      await fsp.writeFile(keyFile, Buffer.from(key.key, "hex"));
      aesKey = { keyFile, ivHex: key.iv };
    } else if (asset.protection === "drm") {
      const { key, created } = await getOrCreateContentKey(assetId);
      drm = key;
      if (created) await registerKeyWithProvider(asset.environmentId, assetId, key);
    }

    /* 5. Encode + package. */
    await setProgress("transcoding", 0.02, true);
    const { dash } = await transcode({
      source,
      probe: info,
      ladder,
      outDir: out,
      trim: start || end < info.duration ? { start, end } : undefined,
      overlay,
      normalizeAudio: asset.normalizeAudio,
      protection: asset.protection,
      aesKey,
      drm,
      onProgress: (p) => void setProgress("transcoding", 0.02 + p * 0.83),
    });

    /* 6. Thumbnails + storyboard (from the clear source, so they work for protected assets too). */
    await setProgress("thumbnails", 0.86, true);
    let hasStoryboard = false;
    if (info.video) {
      const posterFile = path.join(work, "poster.jpg");
      await poster(source, duration / 2, posterFile, start).catch((e) => log.warn({ err: e.message }, "poster failed"));
      if (await exists(posterFile)) await storage.putFile(keys.assetPoster(assetId), posterFile, "image/jpeg");
      const sbFile = path.join(work, "storyboard.jpg");
      try {
        const sb = await storyboard(source, duration, sbFile, { start });
        await storage.putFile(keys.assetStoryboard(assetId), sbFile, "image/jpeg");
        await storage.putBuffer(keys.assetStoryboardJson(assetId), JSON.stringify(sb), "application/json");
        hasStoryboard = true;
      } catch (e: any) {
        log.warn({ err: e.message }, "storyboard failed");
      }
    }

    /* 7. Upload the renditions. */
    await setProgress("uploading", 0.92, true);
    await storage.putDir(out, keys.assetHlsPrefix(assetId));
    if (dash) await storage.putDir(path.join(work, "out", "dash"), keys.assetDashPrefix(assetId));

    /* 8. Mark ready. */
    const renditions: Rendition[] = ladder.map((r) => ({ name: r.name, width: r.width, height: r.height, bitrate: r.videoBitrate, codec: "h264" }));
    const top = ladder[0];
    await db
      .update(assets)
      .set({
        status: "ready",
        duration,
        aspectRatio: info.video ? aspectRatio(info.video.width, info.video.height) : null,
        maxWidth: top?.width ?? null,
        maxHeight: top?.height ?? null,
        maxFrameRate: info.video ? Math.min(info.video.frameRate, 60) : null,
        resolutionTier: top ? resolutionTier(Math.min(top.width, top.height)) : "audio-only",
        renditions,
        hasStoryboard,
        hasDash: dash,
        sourceMeta: {
          container: info.formatName,
          size: info.size,
          bitrate: info.bitrate,
          duration: info.duration,
          video: info.video,
          audio: info.audio,
        },
        errors: null,
        progress: null,
        readyAt: new Date(),
      })
      .where(eq(assets.id, assetId));

    // Media tracks (informational, like Mux's tracks array).
    await db.delete(tracks).where(and(eq(tracks.assetId, assetId), sql`${tracks.type} in ('video','audio')`));
    if (info.video && top) {
      await db.insert(tracks).values({
        id: randomId(24),
        assetId,
        type: "video",
        status: "ready",
        meta: { max_width: top.width, max_height: top.height, max_frame_rate: Math.min(info.video.frameRate, 60), duration },
      });
    }
    if (info.audio) {
      await db.insert(tracks).values({
        id: randomId(24),
        assetId,
        type: "audio",
        status: "ready",
        languageCode: "und",
        name: "Default",
        meta: { max_channels: Math.min(info.audio.channels, 2), duration },
      });
    }

    await recordUsage(asset.environmentId, duration, asset.isLive);

    /* 9. Follow-up work. */
    const textTracks = await db.select().from(tracks).where(and(eq(tracks.assetId, assetId), eq(tracks.type, "text")));
    for (const t of textTracks) {
      if (t.status === "ready") continue;
      if (t.textSource === "uploaded" && (t.meta as any)?.url) {
        await enqueue("track.ingest", { assetId, trackId: t.id, url: (t.meta as any).url });
      } else if (t.textSource === "generated") {
        await enqueue("track.generate-subtitles", { assetId, trackId: t.id });
      }
    }
    if (asset.mp4Support !== "none" && asset.protection !== "drm") {
      await enqueue("asset.static-renditions", { assetId });
    }
    if (asset.ai) await enqueue("asset.ai-insights", { assetId }, { delay: 30_000 });

    const json = await loadAssetJson(assetId);
    await emitEvent(asset.environmentId, "video.asset.ready", json!, { type: "asset", id: assetId });
    if (asset.isLive && asset.liveStreamId) {
      await emitEvent(asset.environmentId, "video.asset.live_stream_completed", json!, { type: "asset", id: assetId });
    }
    if (asset.uploadId) {
      await db.update(uploads).set({ assetId }).where(eq(uploads.id, asset.uploadId));
    }
    log.info({ assetId, duration, renditions: renditions.length }, "asset ready");
    return { duration, renditions: renditions.length };
  } catch (err: any) {
    const final = err instanceof InputError || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    log.error({ assetId, err: err.message, final }, "processing failed");
    if (final) {
      await db
        .update(assets)
        .set({
          status: "errored",
          progress: null,
          errors: { type: err instanceof InputError ? "invalid_input" : "processing_failed", messages: [String(err.message).slice(0, 2000)] },
        })
        .where(eq(assets.id, assetId));
      const json = await loadAssetJson(assetId);
      await emitEvent(asset.environmentId, "video.asset.errored", json!, { type: "asset", id: assetId });
      if (err instanceof InputError) return { error: err.message };
    }
    throw err;
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function exists(f: string) {
  return fsp.stat(f).then(
    () => true,
    () => false,
  );
}

async function registerKeyWithProvider(environmentId: string, assetId: string, key: { keyId: string; key: string; iv: string }) {
  const s = await getDrmSettings(environmentId);
  if (!s.key_registration_url) return;
  const res = await fetch(s.key_registration_url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(s.key_registration_headers ?? {}) },
    body: JSON.stringify({
      asset_id: assetId,
      key_id: key.keyId,
      key: key.key,
      iv: key.iv,
      key_id_uuid: `${key.keyId.slice(0, 8)}-${key.keyId.slice(8, 12)}-${key.keyId.slice(12, 16)}-${key.keyId.slice(16, 20)}-${key.keyId.slice(20)}`,
      key_base64: Buffer.from(key.key, "hex").toString("base64"),
    }),
  });
  if (!res.ok) throw new Error(`DRM key registration failed: HTTP ${res.status}`);
}

export async function recordUsage(environmentId: string, seconds: number, live: boolean) {
  const day = new Date().toISOString().slice(0, 10);
  await getDb()
    .insert(usageDaily)
    .values({ environmentId, day, encodedSeconds: seconds, liveSeconds: live ? seconds : 0 })
    .onConflictDoUpdate({
      target: [usageDaily.environmentId, usageDaily.day],
      set: {
        encodedSeconds: sql`${usageDaily.encodedSeconds} + ${seconds}`,
        liveSeconds: sql`${usageDaily.liveSeconds} + ${live ? seconds : 0}`,
      },
    });
}

