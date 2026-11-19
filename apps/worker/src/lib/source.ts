import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream/promises";
import { storage } from "@vela/core";

const MAX_DOWNLOAD_BYTES = Number(process.env.MAX_INPUT_BYTES ?? 50 * 1024 ** 3);

/** Blocks SSRF to private networks for user-supplied input URLs (override with ALLOW_PRIVATE_INPUT_URLS=true). */
function assertPublicUrl(u: URL) {
  if (process.env.ALLOW_PRIVATE_INPUT_URLS === "true") return;
  const host = u.hostname;
  if (
    host === "localhost" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    host === "0.0.0.0" ||
    host.startsWith("[") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    throw new Error(`Input URL host ${host} is not allowed`);
  }
}

export async function downloadUrl(url: string, dest: string, redirects = 5): Promise<string> {
  const u = new URL(url);
  if (!["http:", "https:"].includes(u.protocol)) throw new Error(`Unsupported URL scheme ${u.protocol}`);
  assertPublicUrl(u);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  // node:http(s) rather than fetch: more tolerant of old/odd servers and streams straight to disk.
  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = (u.protocol === "https:" ? https : http).get(
      u,
      { headers: { "User-Agent": "Vela/1.0 (+video ingest)" }, timeout: 60_000 },
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
  asset: { id: string; input: { url?: string; start_time?: number; end_time?: number }[] },
  dest: string,
): Promise<string[]> {
  const clip = asset.input.find((i) => i.url?.startsWith("vela://assets/"));
  if (clip) {
    await storage.downloadToFile(`assets/${clip.url!.slice("vela://assets/".length)}/source`, dest);
    return [...(clip.start_time ? ["-ss", String(clip.start_time)] : []), ...(clip.end_time ? ["-to", String(clip.end_time)] : [])];
  }
  await storage.downloadToFile(`assets/${asset.id}/source`, dest);
  return [];
}

export async function downloadKey(key: string, dest: string) {
  await storage.downloadToFile(key, dest);
  return dest;
}
