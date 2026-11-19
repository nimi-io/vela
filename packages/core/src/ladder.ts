export type LadderRung = {
  name: string; // e.g. "1080p"
  width: number;
  height: number;
  videoBitrate: number; // bits/s
  maxrate: number;
  bufsize: number;
  audioBitrate: number;
};

export type SourceInfo = {
  width: number;
  height: number;
  frameRate: number;
  videoBitrate?: number; // bits/s, if known
};

const BASE: { short: number; kbps: number }[] = [
  { short: 2160, kbps: 16000 },
  { short: 1440, kbps: 9000 },
  { short: 1080, kbps: 5000 },
  { short: 720, kbps: 2800 },
  { short: 540, kbps: 1600 },
  { short: 360, kbps: 800 },
  { short: 240, kbps: 400 },
];

const TIER_MAX: Record<string, number> = { "1080p": 1080, "1440p": 1440, "2160p": 2160 };
const QUALITY: Record<string, { mult: number; maxRungs: number }> = {
  basic: { mult: 0.7, maxRungs: 3 },
  plus: { mult: 1.0, maxRungs: 6 },
  premium: { mult: 1.3, maxRungs: 7 },
};

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export function resolutionTier(shortSide: number): string {
  if (shortSide >= 2160) return "2160p";
  if (shortSide >= 1440) return "1440p";
  if (shortSide >= 1080) return "1080p";
  if (shortSide >= 720) return "720p";
  return "audio-only-or-sd";
}

/**
 * Builds a content-aware ABR ladder: never upscales, respects the resolution cap and quality
 * level, boosts bitrate for high frame rates, and caps each rung near the source's own bitrate
 * so low-complexity sources (screen recordings, slides) don't waste storage.
 */
export function buildLadder(
  src: SourceInfo,
  opts: { maxResolutionTier?: string; videoQuality?: string } = {},
): LadderRung[] {
  const portrait = src.height > src.width;
  const srcShort = Math.min(src.width, src.height);
  const srcLong = Math.max(src.width, src.height);
  const cap = Math.min(TIER_MAX[opts.maxResolutionTier ?? "1080p"] ?? 1080, srcShort);
  const q = QUALITY[opts.videoQuality ?? "plus"] ?? QUALITY.plus!;
  const fpsMult = src.frameRate > 40 ? 1.5 : 1;

  let rungs = BASE.filter((r) => r.short <= cap);
  if (rungs.length === 0 || rungs[0]!.short < cap) {
    // Source sits between standard sizes (or below 240p): add a top rung at the capped size.
    const below = BASE.find((r) => r.short <= cap);
    const kbps = below ? Math.round((below.kbps * cap) / below.short) : Math.round((400 * cap) / 240);
    rungs = [{ short: cap, kbps }, ...rungs];
  }
  rungs = rungs.slice(0, q.maxRungs);

  return rungs.map((r, i) => {
    const short = even(r.short);
    const long = even((srcLong * r.short) / srcShort);
    let bitrate = r.kbps * 1000 * q.mult * fpsMult;
    if (src.videoBitrate && src.videoBitrate > 0) {
      // Content-aware cap: no rung needs more than ~1.2x the source's own bits for its size.
      const scale = (r.short / srcShort) ** 2;
      bitrate = Math.min(bitrate, Math.max(src.videoBitrate * scale * 1.2, 150_000));
    }
    bitrate = Math.round(bitrate / 1000) * 1000;
    return {
      name: `${r.short}p`,
      width: portrait ? short : long,
      height: portrait ? long : short,
      videoBitrate: bitrate,
      maxrate: Math.round(bitrate * 1.5),
      bufsize: Math.round(bitrate * 2),
      audioBitrate: i === 0 ? 160_000 : r.short <= 360 ? 96_000 : 128_000,
    };
  });
}
