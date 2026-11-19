import type { Resolved } from "./lib/playback.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** Iframe-embeddable player page: /embed/PLAYBACK_ID?token=...&autoplay=1&muted=1 */
export function embedHtml(r: Resolved, q: Record<string, string>) {
  const attrs: string[] = [`playback-id="${esc(r.playbackId)}"`];
  const pass = ["token", "drm-token", "start-time", "primary-color", "watermark-text", "viewer-id", "max-resolution", "poster"];
  for (const k of pass) {
    const v = q[k] ?? q[k.replace(/-/g, "_")];
    if (v) attrs.push(`${k}="${esc(v)}"`);
  }
  for (const flag of ["autoplay", "muted", "loop", "no-analytics"]) {
    const v = q[flag] ?? q[flag.replace(/-/g, "_")];
    if (v && v !== "0" && v !== "false") attrs.push(flag);
  }
  const title = esc(q.title ?? r.asset?.title ?? r.live?.title ?? "Video");
  attrs.push(`video-title="${title}"`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}vela-player{display:block;width:100%;height:100%}</style>
<script src="/player.js" defer></script>
</head>
<body>
<vela-player ${attrs.join(" ")} style="--vela-aspect: auto"></vela-player>
</body>
</html>`;
}
