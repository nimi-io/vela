import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream/promises";
import { env, storage, masterSource, assertSafeUrlSyntax, guardedLookup, privateUrlsAllowed } from "@vela/core";
import { ffmpeg } from "./media.js";

const MAX_DOWNLOAD_BYTES = Number(process.env.MAX_INPUT_BYTES ?? 50 * 1024 ** 3);

export async function downloadUrl(url: string, dest: string, redirects = 5): Promise<string> {
  // Scheme + literal-IP checks here; names are checked on the address actually connected to
  // (guardedLookup), so public names resolving to private IPs and DNS rebinding are refused too.
  // Redirects come back through here, so every hop is checked.
  const allowPrivate = privateUrlsAllowed();
  const u = assertSafeUrlSyntax(url, { allowPrivate });
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  // node:http(s) rather than fetch: more tolerant of old/odd servers and streams straight to disk.
  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = (u.protocol === "https:" ? https : http).get(
      u,
      { headers: { "User-Agent": "Vela/1.0 (+video ingest)" }, timeout: 60_000, ...(allowPrivate ? {} : { lookup: guardedLookup }) },
      resolve,
    );
    req.on("timeout", () => req.destroy(new Error("Download timed out")));
    req.on("error", reject);
  });
  const status = res.statusCode ?? 0;
  if (status >= 300 && status < 400 && res.headers.location) {
    res.resume();
    if (redirects <= 0) throw new Error("Too many redirects");
    return downloadUrl(new URL(res.headers.location, u).toString(), dest, redirects - 1);
  }
  if (status !== 200) {
    res.resume();
    throw new Error(`Download failed: HTTP ${status} for ${url}`);
  }
  const len = Number(res.headers["content-length"] ?? 0);
  if (len > MAX_DOWNLOAD_BYTES) {
    res.destroy();
    throw new Error("Input file is too large");
  }
  let seen = 0;
  res.on("data", (chunk: Buffer) => {
    seen += chunk.length;
    if (seen > MAX_DOWNLOAD_BYTES) res.destroy(new Error("Input file is too large"));
  });
  await pipeline(res, fs.createWriteStream(dest));
  return dest;
}

/**
 * Downloads the master file for an asset. Clips have no master of their own, so this returns the
 * parent's master plus the ffmpeg input args that select the clip's range.
 */
export async function assetMaster(
  asset: { id: string; sourceKey?: string | null; input: { url?: string; start_time?: number; end_time?: number }[] },
  dest: string,
): Promise<string[]> {
  const m = masterSource(asset);
  await storage.downloadToFile(m.key, dest);
  return [...(m.start ? ["-ss", String(m.start)] : []), ...(m.end ? ["-to", String(m.end)] : [])];
}

/**
 * Cuts a clip's own master from its parent's: only the clip range, re-encoded near-losslessly
 * so it starts exactly at start_time (a stream copy would start at the previous keyframe).
 */
export async function cutClipMaster(parent: string, out: string, start: number, end: number | undefined) {
  await ffmpeg([
    "-ss",
    String(start),
    ...(end !== undefined ? ["-to", String(end)] : []),
    "-i",
    parent,
    "-map",
    "0:v:0?",
    "-map",
    "0:a:0?",
    "-c:v",
    "libx264",
    "-preset",
    env().X264_PRESET,
    "-crf",
    "16",
    "-c:a",
    "aac",
    "-b:a",
    "256k",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    out,
  ]);
}

export async function downloadKey(key: string, dest: string) {
  await storage.downloadToFile(key, dest);
  return dest;
}
