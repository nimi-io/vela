import fsp from "node:fs/promises";
import path from "node:path";
import type { Job } from "bullmq";
import { getDb, assets, tracks, eq } from "@vela/db";
import { env, storage, keys, emitEvent, trackJson, randomId, createLogger } from "@vela/core";
import { ffmpeg, probe } from "../lib/media.js";
import { downloadUrl, assetMaster } from "../lib/source.js";
import { transcribe, transcriptionEnabled, llmJson } from "../lib/ai.js";
import { buildVtt, parseVtt, cuesToTranscript, type Cue } from "../lib/vtt.js";
import { cleanUpIfDeleted } from "../lib/deleted.js";

const log = createLogger("worker:tracks");

async function withWork<T>(name: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = path.join(env().WORK_DIR, `${name}-${randomId(6)}`);
  await fsp.mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function loadTrack(trackId: string) {
  const db = getDb();
  const [t] = await db.select().from(tracks).where(eq(tracks.id, trackId));
  if (!t) return null;
  const [a] = await db.select().from(assets).where(eq(assets.id, t.assetId));
  if (!a || a.deletedAt) return null;
  return { track: t, asset: a };
}

async function markReady(trackId: string, storageKey: string, meta?: Record<string, unknown>) {
  const db = getDb();
  const [cur] = await db.select({ assetId: tracks.assetId }).from(tracks).where(eq(tracks.id, trackId));
  // Asset (or track) deleted while we worked: don't leave the VTT we just wrote behind.
  if (!cur) return void (await storage.deleteKey(storageKey).catch(() => {}));
  if (await cleanUpIfDeleted(cur.assetId)) return;
  const [t] = await db.update(tracks).set({ status: "ready", storageKey, ...(meta ? { meta } : {}) }).where(eq(tracks.id, trackId)).returning();
  const [a] = await db.select().from(assets).where(eq(assets.id, t!.assetId));
  await emitEvent(a!.environmentId, "video.asset.track.ready", { asset_id: a!.id, ...trackJson(t!) }, { type: "track", id: t!.id });
}

async function markErrored(trackId: string, message: string) {
  const db = getDb();
  const [t] = await db
    .update(tracks)
    .set({ status: "errored", meta: { error: message.slice(0, 500) } })
    .where(eq(tracks.id, trackId))
    .returning();
  if (!t) return;
  const [a] = await db.select().from(assets).where(eq(assets.id, t.assetId));
  await emitEvent(a!.environmentId, "video.asset.track.errored", { asset_id: a!.id, ...trackJson(t) }, { type: "track", id: t.id });
}

const isFinal = (job: Job) => job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

/** Uploaded subtitle file (VTT/SRT/ASS/...) → normalised WebVTT. */
export async function ingestTrack(job: Job<{ assetId: string; trackId: string; url: string }>) {
  const ctx = await loadTrack(job.data.trackId);
  if (!ctx) return { skipped: true };
  try {
    return await withWork("track", async (dir) => {
      const input = path.join(dir, "input");
      await downloadUrl(job.data.url, input);
      if (ctx.track.type !== "text") throw new Error("Only text tracks can be added from a URL");
      const out = path.join(dir, "out.vtt");
      const head = (await fsp.readFile(input, "utf8")).slice(0, 10);
      if (head.startsWith("WEBVTT") || head.replace(/^﻿/, "").startsWith("WEBVTT")) {
        await fsp.copyFile(input, out);
      } else {
        await ffmpeg(["-i", input, "-f", "webvtt", out]);
      }
      const vtt = await fsp.readFile(out, "utf8");
      if (!parseVtt(vtt).length) throw new Error("Subtitle file contains no cues");
      const key = keys.trackVtt(ctx.asset.id, ctx.track.id);
      await storage.putBuffer(key, vtt, "text/vtt", "public, max-age=300");
      await markReady(ctx.track.id, key, { url: job.data.url });
      return { ok: true };
    });
  } catch (err: any) {
    log.error({ trackId: ctx.track.id, err: err.message }, "track ingest failed");
    if (isFinal(job)) await markErrored(ctx.track.id, err.message);
    throw err;
  }
}

/** Extracts mono 16 kHz MP3 chunks of ≤20 min (keeps each request under Whisper's 25 MB limit). */
async function extractAudioChunks(asset: typeof assets.$inferSelect, dir: string) {
  const src = path.join(dir, "source");
  const trim = await assetMaster(asset, src);
  const audio = path.join(dir, "audio.mp3");
  await ffmpeg([...trim, "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", audio]);
  const duration = (await probe(audio)).duration;
  const chunk = 20 * 60;
  const chunks: { file: string; offset: number }[] = [];
  if (duration <= chunk + 30) return [{ file: audio, offset: 0 }];
  for (let off = 0; off < duration; off += chunk) {
    const f = path.join(dir, `chunk-${off}.mp3`);
    await ffmpeg(["-ss", String(off), "-t", String(chunk), "-i", audio, "-c", "copy", f]);
    chunks.push({ file: f, offset: off });
  }
  return chunks;
}

export async function transcribeAsset(asset: typeof assets.$inferSelect, language: string | undefined, dir: string): Promise<Cue[]> {
  const chunks = await extractAudioChunks(asset, dir);
  const cues: Cue[] = [];
  for (const c of chunks) {
    for (const cue of await transcribe(c.file, language)) {
      cues.push({ start: cue.start + c.offset, end: cue.end + c.offset, text: cue.text });
    }
  }
  return cues;
}

export async function generateSubtitles(job: Job<{ assetId: string; trackId: string }>) {
  const ctx = await loadTrack(job.data.trackId);
  if (!ctx) return { skipped: true };
  if (!transcriptionEnabled()) {
    await markErrored(ctx.track.id, "Auto-generated subtitles need TRANSCRIPTION_PROVIDER configured");
    return { skipped: true };
  }
  try {
    return await withWork("asr", async (dir) => {
      const cues = await transcribeAsset(ctx.asset, ctx.track.languageCode ?? undefined, dir);
      const key = keys.trackVtt(ctx.asset.id, ctx.track.id);
      await storage.putBuffer(key, buildVtt(cues), "text/vtt", "public, max-age=300");
      await markReady(ctx.track.id, key, { cues: cues.length });
      return { cues: cues.length };
    });
  } catch (err: any) {
    log.error({ trackId: ctx.track.id, err: err.message }, "subtitle generation failed");
    if (isFinal(job)) await markErrored(ctx.track.id, err.message);
    throw err;
  }
}

export async function translateTrack(job: Job<{ assetId: string; trackId: string; sourceTrackId: string }>) {
  const ctx = await loadTrack(job.data.trackId);
  const src = await loadTrack(job.data.sourceTrackId);
  if (!ctx || !src?.track.storageKey) return { skipped: true };
  try {
    const cues = parseVtt(await storage.getText(src.track.storageKey));
    const target = ctx.track.languageCode!;
    const out: Cue[] = [];
    const BATCH = 60;
    for (let i = 0; i < cues.length; i += BATCH) {
      const batch = cues.slice(i, i + BATCH);
      const res = await llmJson<{ lines: string[] }>(
        `You translate video subtitles. Translate each line into the language with code "${target}". ` +
          `Keep meaning, tone and line count. Return {"lines": [...]} with exactly ${batch.length} strings, in order.`,
        JSON.stringify({ lines: batch.map((c) => c.text) }),
      );
      batch.forEach((c, j) => out.push({ ...c, text: res.lines?.[j] ?? c.text }));
    }
    const key = keys.trackVtt(ctx.asset.id, ctx.track.id);
    await storage.putBuffer(key, buildVtt(out), "text/vtt", "public, max-age=300");
    await markReady(ctx.track.id, key, { source_track_id: src.track.id });
    return { cues: out.length };
  } catch (err: any) {
    log.error({ trackId: ctx.track.id, err: err.message }, "translation failed");
    if (isFinal(job)) await markErrored(ctx.track.id, err.message);
    throw err;
  }
}

/** Summary, tags and chapters derived from the transcript. */
export async function aiInsights(job: Job<{ assetId: string }>) {
  const db = getDb();
  const [asset] = await db.select().from(assets).where(eq(assets.id, job.data.assetId));
  if (!asset || asset.deletedAt || asset.status !== "ready") return { skipped: true };

  let cues: Cue[] = [];
  const textTracks = await db.select().from(tracks).where(eq(tracks.assetId, asset.id));
  const ready = textTracks.find((t) => t.type === "text" && t.status === "ready" && t.storageKey);
  if (ready) {
    cues = parseVtt(await storage.getText(ready.storageKey!));
  } else if (transcriptionEnabled()) {
    cues = await withWork("insights", (dir) => transcribeAsset(asset, undefined, dir));
  } else {
    await db.update(assets).set({ ai: { summary: undefined, tags: [], chapters: [] } }).where(eq(assets.id, asset.id));
    return { skipped: true, reason: "no transcript" };
  }
  if (!cues.length) return { skipped: true, reason: "empty transcript" };

  const res = await llmJson<{ title?: string; summary?: string; tags?: string[]; chapters?: { start_time: number; title: string }[] }>(
    "You analyse video transcripts. Return JSON: {\"title\": short title, \"summary\": 2-4 sentence summary, " +
      "\"tags\": up to 10 lowercase topic tags, \"chapters\": [{\"start_time\": seconds (number), \"title\": short chapter title}]}. " +
      "Chapters must start at 0, be in order, and only be included for videos longer than 2 minutes with distinct sections.",
    `Duration: ${Math.round(asset.duration ?? 0)} seconds\nTranscript:\n${cuesToTranscript(cues)}`,
  );
  const ai = {
    summary: res.summary,
    tags: (res.tags ?? []).slice(0, 10),
    chapters: (res.chapters ?? []).filter((c) => typeof c.start_time === "number" && c.start_time <= (asset.duration ?? Infinity)),
  };
  await db
    .update(assets)
    .set({ ai, title: asset.title ?? res.title?.slice(0, 200) ?? null })
    .where(eq(assets.id, asset.id));
  return ai;
}
