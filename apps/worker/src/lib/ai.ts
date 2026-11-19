import fsp from "node:fs/promises";
import { env } from "@vela/core";
import type { Cue } from "./vtt.js";

export function transcriptionEnabled() {
  const e = env();
  if (e.TRANSCRIPTION_PROVIDER === "openai") return !!e.OPENAI_API_KEY;
  if (e.TRANSCRIPTION_PROVIDER === "cloudflare") return !!(e.CLOUDFLARE_ACCOUNT_ID && e.CLOUDFLARE_API_TOKEN);
  return false;
}

/** Transcribes one audio file (mono mp3, < 25 MB). Returns cues relative to the file start. */
export async function transcribe(file: string, language?: string): Promise<Cue[]> {
  const e = env();
  const audio = await fsp.readFile(file);
  const lang = language?.split("-")[0];

  if (e.TRANSCRIPTION_PROVIDER === "openai") {
    const form = new FormData();
    form.append("file", new Blob([audio], { type: "audio/mpeg" }), "audio.mp3");
    form.append("model", e.WHISPER_MODEL);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    if (lang && lang !== "auto") form.append("language", lang);
    const res = await fetch(`${e.OPENAI_BASE_URL}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${e.OPENAI_API_KEY}` },
      body: form,
    });
    if (!res.ok) throw new Error(`Transcription failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { segments?: { start: number; end: number; text: string }[]; text?: string };
    return (json.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text }));
  }

  if (e.TRANSCRIPTION_PROVIDER === "cloudflare") {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${e.CLOUDFLARE_ACCOUNT_ID}/ai/run/${e.CLOUDFLARE_WHISPER_MODEL}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${e.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ audio: audio.toString("base64"), ...(lang && lang !== "auto" ? { language: lang } : {}) }),
      },
    );
    if (!res.ok) throw new Error(`Transcription failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { result?: { segments?: { start: number; end: number; text: string }[] } };
    return (json.result?.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text }));
  }

  throw new Error("Transcription is not configured (set TRANSCRIPTION_PROVIDER)");
}

export function llmEnabled() {
  const e = env();
  return (
    (e.TRANSCRIPTION_PROVIDER === "openai" && !!e.OPENAI_API_KEY) ||
    (e.TRANSCRIPTION_PROVIDER === "cloudflare" && !!e.CLOUDFLARE_ACCOUNT_ID && !!e.CLOUDFLARE_API_TOKEN) ||
    !!e.OPENAI_API_KEY
  );
}

/** Chat completion that must return JSON. Uses an OpenAI-compatible API, or Cloudflare Workers AI. */
export async function llmJson<T>(system: string, user: string): Promise<T> {
  const e = env();
  let text: string;
  if (e.OPENAI_API_KEY) {
    const res = await fetch(`${e.OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${e.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: e.LLM_MODEL,
        response_format: { type: "json_object" },
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`LLM request failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    text = json.choices[0]?.message.content ?? "{}";
  } else if (e.CLOUDFLARE_ACCOUNT_ID && e.CLOUDFLARE_API_TOKEN) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${e.CLOUDFLARE_ACCOUNT_ID}/ai/run/${e.CLOUDFLARE_LLM_MODEL}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${e.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        max_tokens: 4096,
        messages: [
          { role: "system", content: `${system}\nRespond with a single JSON object only.` },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`LLM request failed: HTTP ${res.status}`);
    const json = (await res.json()) as { result?: { response?: string } };
    text = json.result?.response ?? "{}";
  } else {
    throw new Error("No LLM configured (set OPENAI_API_KEY or Cloudflare credentials)");
  }
  const match = text.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : text) as T;
}
