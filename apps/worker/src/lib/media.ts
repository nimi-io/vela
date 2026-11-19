import { env } from "@vela/core";
import { run } from "./exec.js";

export type ProbeResult = {
  duration: number;
  formatName: string;
  size: number;
  bitrate: number;
  video?: {
    codec: string;
    width: number;
    height: number;
    frameRate: number;
    bitrate?: number;
    rotation: number;
    pixFmt?: string;
  };
  audio?: { codec: string; channels: number; sampleRate: number; bitrate?: number; count: number };
  raw: unknown;
};

function parseRate(r?: string): number {
  if (!r) return 0;
  const [n, d] = r.split("/").map(Number);
  return d ? n! / d : n ?? 0;
}

export async function probe(input: string): Promise<ProbeResult> {
  const { stdout } = await run(env().FFPROBE_PATH, [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    input,
  ]);
  const data = JSON.parse(stdout) as { format: any; streams: any[] };
  const v = data.streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const audios = data.streams.filter((s) => s.codec_type === "audio");
  const a = audios[0];
  let rotation = 0;
  if (v) {
    const side = (v.side_data_list ?? []).find((s: any) => s.rotation !== undefined);
    rotation = Math.abs(Number(side?.rotation ?? v.tags?.rotate ?? 0)) % 360;
  }
  const swap = rotation === 90 || rotation === 270;
  const duration = Number(data.format?.duration ?? v?.duration ?? a?.duration ?? 0);
  return {
    duration,
    formatName: data.format?.format_name ?? "",
    size: Number(data.format?.size ?? 0),
    bitrate: Number(data.format?.bit_rate ?? 0),
    video: v
      ? {
          codec: v.codec_name,
          width: swap ? v.height : v.width,
          height: swap ? v.width : v.height,
          frameRate: Math.min(parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) || 30, 120),
          bitrate: v.bit_rate ? Number(v.bit_rate) : undefined,
          rotation,
          pixFmt: v.pix_fmt,
        }
      : undefined,
    audio: a
      ? {
          codec: a.codec_name,
          channels: Number(a.channels ?? 2),
          sampleRate: Number(a.sample_rate ?? 48000),
          bitrate: a.bit_rate ? Number(a.bit_rate) : undefined,
          count: audios.length,
        }
      : undefined,
    raw: data,
  };
}

export function aspectRatio(w: number, h: number): string {
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = gcd(w, h) || 1;
  const rw = w / g;
  const rh = h / g;
  // Collapse ugly ratios (e.g. 683:384) to a decimal-ish common form.
  if (rw > 64 || rh > 64) return `${(w / h).toFixed(2)}:1`;
  return `${rw}:${rh}`;
}

/** Runs ffmpeg with -progress and reports 0..1 progress against a known duration. */
export async function ffmpeg(args: string[], opts: { duration?: number; onProgress?: (p: number) => void; timeoutMs?: number } = {}) {
  const full = ["-hide_banner", "-nostdin", "-y", ...(opts.onProgress ? ["-progress", "pipe:1", "-nostats"] : []), ...args];
  return run(env().FFMPEG_PATH, full, {
    timeoutMs: opts.timeoutMs,
    onStdoutLine: opts.onProgress
      ? (line) => {
          if (line.startsWith("out_time_us=") || line.startsWith("out_time_ms=")) {
            const us = Number(line.split("=")[1]);
            if (opts.duration && us > 0) opts.onProgress!(Math.min(1, us / 1e6 / opts.duration));
          }
        }
      : undefined,
  });
}
