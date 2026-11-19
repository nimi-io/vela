export type Cue = { start: number; end: number; text: string };

export function formatTime(t: number): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const pad = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(r, 3)}`;
}

function parseTime(s: string): number {
  const parts = s.trim().replace(",", ".").split(":");
  let sec = 0;
  for (const p of parts) sec = sec * 60 + parseFloat(p);
  return sec;
}

export function buildVtt(cues: Cue[]): string {
  return (
    "WEBVTT\n\n" +
    cues
      .filter((c) => c.text.trim())
      .map((c, i) => `${i + 1}\n${formatTime(c.start)} --> ${formatTime(c.end)}\n${c.text.trim()}\n`)
      .join("\n")
  );
}

export function parseVtt(vtt: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = vtt.replace(/\r/g, "").split(/\n\n+/);
  for (const b of blocks) {
    const lines = b.split("\n").filter(Boolean);
    const idx = lines.findIndex((l) => l.includes("-->"));
    if (idx < 0) continue;
    const [a, z] = lines[idx]!.split("-->");
    cues.push({ start: parseTime(a!), end: parseTime(z!.trim().split(/\s+/)[0]!), text: lines.slice(idx + 1).join("\n") });
  }
  return cues;
}

/** "[mm:ss] text" transcript used as LLM context. */
export function cuesToTranscript(cues: Cue[], maxChars = 60_000): string {
  const out: string[] = [];
  let len = 0;
  for (const c of cues) {
    const m = Math.floor(c.start / 60);
    const s = Math.floor(c.start % 60);
    const line = `[${m}:${String(s).padStart(2, "0")}] ${c.text.replace(/\n/g, " ")}`;
    len += line.length + 1;
    if (len > maxChars) break;
    out.push(line);
  }
  return out.join("\n");
}
