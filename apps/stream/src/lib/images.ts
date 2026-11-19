import { spawn } from "node:child_process";
import { env, storage, keys, contentTypeFor } from "@vela/core";
import { Semaphore } from "./cache.js";
import type { Resolved } from "./playback.js";

const ffmpegSlots = new Semaphore(Number(process.env.STREAM_FFMPEG_CONCURRENCY ?? 4));

function ffmpegToBuffer(args: string[], timeoutMs = 30_000): Promise<Buffer> {
  return ffmpegSlots.run(
    () =>
      new Promise((resolve, reject) => {
        const child = spawn(env().FFMPEG_PATH, ["-hide_banner", "-nostdin", "-loglevel", "error", ...args], { stdio: ["ignore", "pipe", "pipe"] });
        const chunks: Buffer[] = [];
        let err = "";
        child.stdout.on("data", (d) => chunks.push(d));
        child.stderr.on("data", (d) => (err += d.toString()));
        const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
        child.on("close", (code) => {
          clearTimeout(t);
          const buf = Buffer.concat(chunks);
          if (code === 0 && buf.length) resolve(buf);
          else reject(new Error(err.trim().split("\n").slice(-3).join(" ") || `ffmpeg exited ${code}`));
        });
        child.on("error", reject);
      }),
  );
}

/** Where to read frames from: the master (with clip offset) or the live ingest. */
async function frameSource(r: Resolved): Promise<{ url: string; offset: number; live: boolean }> {
  const e = env();
  if (r.live) {
    return {
      url: `${e.MEDIAMTX_RTMP_URL}/live/${r.live.streamKey}?user=internal&pass=${encodeURIComponent(e.INTERNAL_SECRET)}`,
      offset: 0,
      live: true,
    };
  }
  const a = r.asset!;
  const clip = a.input.find((i) => i.url?.startsWith("vela://assets/"));
  const sourceAsset = clip ? clip.url!.slice("vela://assets/".length) : a.id;
  const url = await storage.presignGet(keys.assetSource(sourceAsset), 600, { public: false });
  return { url, offset: clip?.start_time ?? 0, live: false };
}

const clampInt = (v: string | undefined, min: number, max: number) => {
  if (v === undefined || v === "") return undefined;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
};

function sizeFilter(w?: number, h?: number, fit = "preserve") {
  if (!w && !h) return "scale='min(1280,iw)':-2";
  if (w && h) {
    if (fit === "crop" || fit === "smartcrop") return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
    if (fit === "pad") return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`;
    if (fit === "stretch") return `scale=${w}:${h}`;
    return `scale=${w}:${h}:force_original_aspect_ratio=decrease`;
  }
  return w ? `scale=${w}:-2` : `scale=-2:${h}`;
}

export async function thumbnail(r: Resolved, format: "jpg" | "png" | "webp", q: Record<string, string>) {
  const width = clampInt(q.width, 16, 2000);
  const height = clampInt(q.height, 16, 2000);
  const fit = q.fit_mode ?? "preserve";
  const duration = r.asset?.duration ?? 0;
  let time = q.time !== undefined ? Number(q.time) : undefined;
  if (time !== undefined && (!Number.isFinite(time) || time < 0)) time = 0;
  if (time !== undefined && duration) time = Math.min(time, Math.max(0, duration - 0.1));

  // Fast path: default poster frame.
  if (!r.live && time === undefined && !width && !height && format === "jpg") {
    const poster = keys.assetPoster(r.asset!.id);
    if (await storage.exists(poster)) return { body: await storage.getBuffer(poster), type: "image/jpeg", cache: 86400 };
  }

  const variant = `t${time ?? "mid"}_w${width ?? 0}_h${height ?? 0}_${fit}.${format}`;
  const cacheKey = r.asset ? keys.assetThumbCache(r.asset.id, variant) : null;
  if (cacheKey && (await storage.exists(cacheKey))) return { body: await storage.getBuffer(cacheKey), type: contentTypeFor(variant), cache: 86400 };

  const src = await frameSource(r);
  const at = src.live ? [] : ["-ss", String(src.offset + (time ?? duration / 2))];
  const codec = format === "png" ? ["-c:v", "png", "-f", "image2pipe"] : format === "webp" ? ["-c:v", "libwebp", "-f", "webp"] : ["-c:v", "mjpeg", "-q:v", "3", "-f", "image2pipe"];
  const body = await ffmpegToBuffer([...at, "-i", src.url, "-frames:v", "1", "-vf", sizeFilter(width, height, fit), ...codec, "pipe:1"]);
  if (cacheKey) await storage.putBuffer(cacheKey, body, contentTypeFor(variant)).catch(() => {});
  return { body, type: contentTypeFor(variant), cache: src.live ? 5 : 86400 };
}

export async function animated(r: Resolved, format: "gif" | "webp", q: Record<string, string>) {
  if (r.live) throw new Error("Animated images are only available for assets");
  const duration = r.asset!.duration ?? 0;
  const start = Math.max(0, Math.min(Number(q.start ?? 0) || 0, Math.max(0, duration - 0.5)));
  const end = Math.min(Number(q.end ?? start + 5) || start + 5, start + 10, duration || start + 5);
  const width = clampInt(q.width, 32, 640) ?? 320;
  const height = clampInt(q.height, 32, 640);
  const fps = clampInt(q.fps, 1, 30) ?? 15;
  const variant = `anim_${start}_${end}_${width}_${height ?? 0}_${fps}.${format}`;
  const cacheKey = keys.assetThumbCache(r.asset!.id, variant);
  if (await storage.exists(cacheKey)) return { body: await storage.getBuffer(cacheKey), type: contentTypeFor(variant) };

  const src = await frameSource(r);
  const scale = height ? `scale=${width}:${height}:force_original_aspect_ratio=decrease` : `scale=${width}:-2`;
  const args =
    format === "gif"
      ? ["-vf", `fps=${fps},${scale}:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer`, "-loop", "0", "-f", "gif"]
      : ["-vf", `fps=${fps},${scale}`, "-c:v", "libwebp", "-loop", "0", "-q:v", "60", "-f", "webp"];
  const body = await ffmpegToBuffer(["-ss", String(src.offset + start), "-t", String(end - start), "-i", src.url, "-an", ...args, "pipe:1"], 60_000);
  await storage.putBuffer(cacheKey, body, contentTypeFor(variant)).catch(() => {});
  return { body, type: contentTypeFor(variant) };
}
