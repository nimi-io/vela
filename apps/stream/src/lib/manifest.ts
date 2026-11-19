/** HLS/DASH manifest rewriting (pure functions — unit tested). */

export type SubtitleTrack = { id: string; name: string; language: string; isDefault?: boolean; closedCaptions?: boolean };

function parseAttrs(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = line.slice(line.indexOf(":") + 1);
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(body))) out[m[1]!] = m[2]!.replace(/^"|"$/g, "");
  return out;
}

/**
 * Rewrites a VOD master playlist so every URI points through the stream service under
 * `${base}/` (e.g. /PLAYBACK_ID/TOKEN/hls/), optionally filtering renditions and adding subtitles.
 */
export function rewriteMaster(
  master: string,
  base: string,
  opts: { minShortSide?: number; maxShortSide?: number; subtitles?: SubtitleTrack[]; subtitleUri?: (id: string) => string } = {},
): string {
  const lines = master.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  const subs = opts.subtitles ?? [];
  const hasSubs = subs.length > 0 && !!opts.subtitleUri;
  let pendingStreamInf: string | null = null;
  let skipNextUri = false;
  let insertedSubs = false;
  const variantCandidates: { inf: string; uri: string; short: number }[] = [];

  // First pass: collect variants to decide filtering (always keep at least one).
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith("#EXT-X-STREAM-INF")) {
      const res = parseAttrs(l).RESOLUTION;
      const [w, h] = res ? res.split("x").map(Number) : [0, 0];
      variantCandidates.push({ inf: l, uri: lines[i + 1] ?? "", short: Math.min(w || 0, h || 0) });
    }
  }
  const allowed = new Set(
    variantCandidates
      .filter((v) => (!opts.maxShortSide || !v.short || v.short <= opts.maxShortSide) && (!opts.minShortSide || !v.short || v.short >= opts.minShortSide))
      .map((v) => v.inf),
  );
  if (allowed.size === 0 && variantCandidates.length) {
    // Requested range excludes everything: keep the closest rendition instead of failing.
    const sorted = [...variantCandidates].sort((a, b) => a.short - b.short);
    allowed.add((opts.maxShortSide ? sorted[0] : sorted[sorted.length - 1])!.inf);
  }

  const abs = (uri: string) => (/^[a-z]+:/i.test(uri) || uri.startsWith("/") ? uri : `${base}${uri}`);

  for (const l of lines) {
    if (skipNextUri && l && !l.startsWith("#")) {
      skipNextUri = false;
      continue;
    }
    if (l.startsWith("#EXT-X-STREAM-INF")) {
      if (!allowed.has(l)) {
        skipNextUri = true;
        continue;
      }
      if (hasSubs && !insertedSubs) {
        subs.forEach((s, idx) =>
          out.push(
            `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${s.name.replace(/"/g, "'")}",LANGUAGE="${s.language}",DEFAULT=${s.isDefault && idx === 0 ? "YES" : "NO"},AUTOSELECT=YES,FORCED=NO${s.closedCaptions ? `,CHARACTERISTICS="public.accessibility.transcribes-spoken-dialog,public.accessibility.describes-music-and-sound"` : ""},URI="${opts.subtitleUri!(s.id)}"`,
          ),
        );
        insertedSubs = true;
      }
      pendingStreamInf = hasSubs && !l.includes("SUBTITLES=") ? `${l},SUBTITLES="subs"` : l;
      out.push(pendingStreamInf);
      continue;
    }
    if (l.startsWith("#EXT-X-MEDIA") || l.startsWith("#EXT-X-I-FRAME-STREAM-INF")) {
      out.push(l.replace(/URI="([^"]+)"/, (_m, u) => `URI="${abs(u)}"`));
      continue;
    }
    if (l && !l.startsWith("#")) {
      out.push(abs(l));
      continue;
    }
    out.push(l);
  }
  return out.join("\n");
}

/** Points the AES-128 key placeholder at the authorised key endpoint. */
export function rewriteMediaKey(playlist: string, keyUri: string): string {
  return playlist.replace(/URI="vela-key:\/\/asset"/g, `URI="${keyUri}"`);
}

/** Rewrites a live (MediaMTX) multivariant playlist's relative URIs under `${base}`. */
export function rewriteLiveMaster(master: string, base: string): string {
  return master
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => {
      if (l.startsWith("#EXT-X-MEDIA") || l.startsWith("#EXT-X-I-FRAME-STREAM-INF")) {
        return l.replace(/URI="([^"]+)"/, (_m, u) => `URI="${u.startsWith("/") || /^[a-z]+:/i.test(u) ? u : base + u}"`);
      }
      if (l && !l.startsWith("#") && !l.startsWith("/") && !/^[a-z]+:/i.test(l)) return base + l;
      return l;
    })
    .join("\n");
}

/** Single-segment WebVTT media playlist for a subtitle track. */
export function subtitlePlaylist(vttUri: string, duration: number): string {
  const d = Math.max(1, Math.ceil(duration));
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${d}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXTINF:${duration.toFixed(3)},`,
    vttUri,
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
}

/** Adds an MPD-level BaseURL so relative segment paths resolve through the stream service. */
export function rewriteMpd(mpd: string, baseUrl: string): string {
  const withoutBase = mpd.replace(/<BaseURL>[^<]*<\/BaseURL>\s*/g, "");
  return withoutBase.replace(/(<MPD[^>]*>)/, `$1\n  <BaseURL>${baseUrl}</BaseURL>`);
}

export function storyboardVtt(
  sb: { count: number; interval: number; cols: number; tileWidth: number },
  tileHeight: number,
  imageUrl: string,
  duration: number,
): string {
  const fmt = (t: number) => {
    const ms = Math.round(t * 1000);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
  };
  const out = ["WEBVTT", ""];
  for (let i = 0; i < sb.count; i++) {
    const start = i * sb.interval;
    const end = Math.min(duration, (i + 1) * sb.interval);
    const x = (i % sb.cols) * sb.tileWidth;
    const y = Math.floor(i / sb.cols) * tileHeight;
    out.push(`${fmt(start)} --> ${fmt(end)}`, `${imageUrl}#xywh=${x},${y},${sb.tileWidth},${tileHeight}`, "");
  }
  return out.join("\n");
}

export function chaptersVtt(chapters: { start_time: number; title: string }[], duration: number): string {
  const fmt = (t: number) => new Date(Math.max(0, t) * 1000).toISOString().slice(11, 23);
  const out = ["WEBVTT", ""];
  const sorted = [...chapters].sort((a, b) => a.start_time - b.start_time);
  sorted.forEach((c, i) => {
    const end = sorted[i + 1]?.start_time ?? duration;
    if (end > c.start_time) out.push(`${fmt(c.start_time)} --> ${fmt(end)}`, c.title, "");
  });
  return out.join("\n");
}
