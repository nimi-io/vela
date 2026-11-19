import fsp from "node:fs/promises";
import path from "node:path";
import { env, type LadderRung } from "@vela/core";
import type { AssetInputSettings } from "@vela/db";
import { ffmpeg, type ProbeResult } from "./media.js";
import { run } from "./exec.js";

export type TranscodeInput = {
  source: string;
  probe: ProbeResult;
  ladder: LadderRung[];
  outDir: string;
  trim?: { start?: number; end?: number };
  overlay?: { file: string; settings: NonNullable<AssetInputSettings["overlay_settings"]> };
  normalizeAudio: boolean;
  protection: "none" | "aes-128" | "drm";
  aesKey?: { keyFile: string; ivHex: string };
  drm?: { keyId: string; key: string; iv: string };
  onProgress?: (p: number) => void;
};

const SEGMENT_SECONDS = 4;

function videoEncoderArgs(i: number, r: LadderRung, gop: number): string[] {
  const e = env();
  const common = [`-b:v:${i}`, String(r.videoBitrate), `-maxrate:v:${i}`, String(r.maxrate), `-bufsize:v:${i}`, String(r.bufsize)];
  if (e.HW_ACCEL === "nvenc") {
    return [`-c:v:${i}`, "h264_nvenc", `-preset:v:${i}`, "p4", `-rc:v:${i}`, "vbr", ...common, `-g:v:${i}`, String(gop)];
  }
  return [
    `-c:v:${i}`,
    "libx264",
    `-preset:v:${i}`,
    e.X264_PRESET,
    `-profile:v:${i}`,
    r.height >= 720 || r.width >= 1280 ? "high" : "main",
    ...common,
  ];
}

/** Position expression for the overlay filter. Margins/width accept "5%" or "20px". */
function overlayFilter(settings: NonNullable<AssetInputSettings["overlay_settings"]>, srcW: number) {
  const px = (v: string | undefined, ref: string, def: string) => {
    if (!v) return def;
    if (v.endsWith("%")) return `${ref}*${parseFloat(v) / 100}`;
    return String(parseFloat(v));
  };
  const w = settings.width ? (settings.width.endsWith("%") ? Math.round((srcW * parseFloat(settings.width)) / 100) : parseFloat(settings.width)) : Math.round(srcW * 0.15);
  const vm = px(settings.vertical_margin, "main_h", "main_h*0.05");
  const hm = px(settings.horizontal_margin, "main_w", "main_w*0.05");
  const x =
    settings.horizontal_align === "left" ? hm : settings.horizontal_align === "center" ? "(main_w-overlay_w)/2" : `main_w-overlay_w-${hm}`;
  const y =
    settings.vertical_align === "top" ? vm : settings.vertical_align === "middle" ? "(main_h-overlay_h)/2" : `main_h-overlay_h-${vm}`;
  const opacity = settings.opacity ? Math.max(0, Math.min(1, parseFloat(settings.opacity) / (settings.opacity.endsWith("%") ? 100 : 1))) : 1;
  return { scale: `scale=${Math.max(2, Math.round(w / 2) * 2)}:-2,format=rgba,colorchannelmixer=aa=${opacity}`, x, y };
}

/**
 * Encodes the ABR ladder.
 *  - none:    HLS with fMP4/CMAF segments written directly by ffmpeg
 *  - aes-128: HLS with MPEG-TS segments encrypted by ffmpeg (fMP4 encryption isn't supported by ffmpeg)
 *  - drm:     ffmpeg encodes per-rendition MP4s, Shaka Packager produces CENC (cbcs) HLS + DASH
 */
export async function transcode(t: TranscodeInput): Promise<{ dash: boolean }> {
  const { probe, ladder } = t;
  const hasVideo = !!probe.video && ladder.length > 0;
  const hasAudio = !!probe.audio;
  const fps = probe.video ? Math.min(probe.video.frameRate || 30, 60) : 30;
  const gop = Math.max(1, Math.round(fps * 2)); // 2s GOPs, segments are 2 GOPs long
  const duration = Math.max(0.1, (t.trim?.end ?? probe.duration) - (t.trim?.start ?? 0));

  const inputArgs: string[] = [];
  if (t.trim?.start) inputArgs.push("-ss", String(t.trim.start));
  if (t.trim?.end) inputArgs.push("-to", String(t.trim.end));
  inputArgs.push("-i", t.source);
  if (t.overlay) inputArgs.push("-i", t.overlay.file);

  // Video filter graph: optional fps cap + overlay, then split into each rung.
  const filters: string[] = [];
  if (hasVideo) {
    let head = `[0:v:0]setsar=1${probe.video!.frameRate > 60 ? ",fps=60" : ""}`;
    if (t.overlay) {
      const o = overlayFilter(t.overlay.settings, probe.video!.width);
      filters.push(`[1:v]${o.scale}[wm]`);
      filters.push(`${head}[base]`);
      head = `[base][wm]overlay=${o.x}:${o.y}`;
    }
    filters.push(`${head},split=${ladder.length}${ladder.map((_, i) => `[s${i}]`).join("")}`);
    ladder.forEach((r, i) => filters.push(`[s${i}]scale=${r.width}:${r.height}:flags=bicubic,format=yuv420p[v${i}]`));
  }
  const audioFilter = t.normalizeAudio ? ["-af", "loudnorm=I=-16:TP=-1.5:LRA=11"] : [];
  const keyframes = ["-g", String(gop), "-keyint_min", String(gop), "-sc_threshold", "0", "-force_key_frames", `expr:gte(t,n_forced*2)`];
  const audioRungs = hasVideo ? ladder : [{ audioBitrate: 160_000 } as LadderRung];

  if (t.protection === "drm") {
    await fsp.mkdir(path.join(t.outDir, "_mezz"), { recursive: true });
    const mezz = path.join(t.outDir, "_mezz");
    const args = [...inputArgs];
    if (filters.length) args.push("-filter_complex", filters.join(";"));
    if (hasVideo) {
      ladder.forEach((r, i) => {
        args.push("-map", `[v${i}]`, "-an", ...videoEncoderArgs(0, r, gop).map((a) => a.replace(":v:0", ":v")), ...keyframes, "-movflags", "+faststart", path.join(mezz, `${r.name}.mp4`));
      });
    }
    if (hasAudio) {
      args.push("-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "160k", "-ac", "2", ...audioFilter, path.join(mezz, "audio.mp4"));
    }
    await ffmpeg(args, { duration, onProgress: (p) => t.onProgress?.(p * 0.85) });
    await packageDrm(t, mezz);
    await fsp.rm(mezz, { recursive: true, force: true });
    t.onProgress?.(1);
    return { dash: true };
  }

  const args = [...inputArgs];
  if (filters.length) args.push("-filter_complex", filters.join(";"));
  const streamMap: string[] = [];
  if (hasVideo) {
    ladder.forEach((r, i) => {
      args.push("-map", `[v${i}]`);
      args.push(...videoEncoderArgs(i, r, gop));
    });
  }
  if (hasAudio) {
    audioRungs.forEach((r, i) => {
      args.push("-map", "0:a:0", `-c:a:${i}`, "aac", `-b:a:${i}`, String(r.audioBitrate), `-ac:a:${i}`, "2");
    });
    args.push(...audioFilter);
  }
  if (hasVideo) {
    ladder.forEach((r, i) => streamMap.push(hasAudio ? `v:${i},a:${i},name:${r.name}` : `v:${i},name:${r.name}`));
  } else {
    streamMap.push("a:0,name:audio");
  }
  const ts = t.protection === "aes-128";
  args.push(
    ...(hasVideo ? keyframes : []),
    "-f",
    "hls",
    "-hls_time",
    String(SEGMENT_SECONDS),
    "-hls_playlist_type",
    "vod",
    "-hls_flags",
    "independent_segments",
    ...(ts
      ? ["-hls_segment_type", "mpegts", "-hls_key_info_file", await writeKeyInfo(t)]
      : ["-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4"]),
    "-hls_segment_filename",
    path.join(t.outDir, `%v/seg_%05d.${ts ? "ts" : "m4s"}`),
    "-master_pl_name",
    "master.m3u8",
    "-var_stream_map",
    streamMap.join(" "),
    path.join(t.outDir, "%v/index.m3u8"),
  );
  await ffmpeg(args, { duration, onProgress: t.onProgress });
  if (ts) await fsp.rm(path.join(t.outDir, "keyinfo"), { force: true });
  return { dash: false };
}

async function writeKeyInfo(t: TranscodeInput) {
  if (!t.aesKey) throw new Error("aes-128 protection requires a key");
  const file = path.join(t.outDir, "keyinfo");
  // The URI is a placeholder; the stream service rewrites it to an authorised key URL.
  await fsp.writeFile(file, `vela-key://asset\n${t.aesKey.keyFile}\n${t.aesKey.ivHex}\n`);
  return file;
}

/**
 * Shaka Packager command line for a DRM asset. HLS and DASH share one set of CMAF segments in
 * `outDir` (uploaded as hls/). The MPD is written into `outDir` too, so packager emits segment
 * paths relative to it ("720p/init.mp4"); it writes absolute local paths for segments outside the
 * MPD's directory. The caller moves the MPD to dash/ and the stream service serves it with a
 * BaseURL pointing at hls/.
 */
export function drmPackagerArgs(
  outDir: string,
  mezz: string,
  files: string[],
  drm: { keyId: string; key: string; iv: string },
): string[] {
  const args: string[] = [];
  for (const f of files.filter((x) => x.endsWith(".mp4") && x !== "audio.mp4")) {
    const name = f.replace(/\.mp4$/, "");
    args.push(
      `in=${path.join(mezz, f)},stream=video,init_segment=${outDir}/${name}/init.mp4,segment_template=${outDir}/${name}/seg_$Number%05d$.m4s,playlist_name=${name}/index.m3u8,iframe_playlist_name=${name}/iframe.m3u8`,
    );
  }
  if (files.includes("audio.mp4")) {
    args.push(
      `in=${path.join(mezz, "audio.mp4")},stream=audio,init_segment=${outDir}/audio/init.mp4,segment_template=${outDir}/audio/seg_$Number%05d$.m4s,playlist_name=audio/index.m3u8,hls_group_id=audio,hls_name=Default`,
    );
  }
  args.push(
    "--segment_duration",
    String(SEGMENT_SECONDS),
    "--enable_raw_key_encryption",
    "--keys",
    `label=:key_id=${drm.keyId}:key=${drm.key}`,
    "--iv",
    drm.iv,
    "--protection_scheme",
    "cbcs",
    "--clear_lead",
    "0",
    "--protection_systems",
    "Widevine,PlayReady,FairPlay,CommonSystem",
    "--hls_key_uri",
    `skd://${drm.keyId}`,
    "--hls_master_playlist_output",
    `${outDir}/master.m3u8`,
    "--mpd_output",
    `${outDir}/manifest.mpd`,
  );
  return args;
}

async function packageDrm(t: TranscodeInput, mezz: string) {
  if (!t.drm) throw new Error("drm protection requires a content key");
  const args = drmPackagerArgs(t.outDir, mezz, await fsp.readdir(mezz), t.drm);
  await run(env().PACKAGER_PATH, args, { timeoutMs: 6 * 3600_000 });
  const dashDir = path.join(t.outDir, "..", "dash");
  await fsp.mkdir(dashDir, { recursive: true });
  await fsp.rename(path.join(t.outDir, "manifest.mpd"), path.join(dashDir, "manifest.mpd"));
}

/** Poster frame (1280 wide max). */
export async function poster(source: string, time: number, out: string, trimStart = 0) {
  await ffmpeg(["-ss", String(trimStart + time), "-i", source, "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-q:v", "3", out]);
}

/** Storyboard sprite: up to 100 evenly spaced 256px-wide tiles, 10 per row. */
export async function storyboard(source: string, duration: number, out: string, trim?: { start?: number }) {
  const count = Math.max(1, Math.min(100, Math.floor(duration / 2)));
  const interval = duration / count;
  const cols = Math.min(10, count);
  const rows = Math.ceil(count / cols);
  await ffmpeg([
    ...(trim?.start ? ["-ss", String(trim.start)] : []),
    "-i",
    source,
    "-t",
    String(duration),
    "-an",
    "-vf",
    `fps=1/${interval.toFixed(4)},scale=256:-2,tile=${cols}x${rows}`,
    "-frames:v",
    "1",
    "-q:v",
    "4",
    out,
  ]);
  return { count, interval, cols, rows, tileWidth: 256 };
}
