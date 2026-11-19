import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { env } from "./env.js";

let internal: S3Client | undefined;
let publicClient: S3Client | undefined;

function makeClient(endpoint?: string) {
  const e = env();
  return new S3Client({
    region: e.S3_REGION,
    endpoint: endpoint || undefined,
    forcePathStyle: e.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY },
    // R2 and many S3-compatible providers don't support the newer default checksum headers.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

export function s3(): S3Client {
  return (internal ??= makeClient(env().S3_ENDPOINT));
}

/** Client used to presign URLs handed to browsers (endpoint may differ from the internal one). */
function s3Public(): S3Client {
  const e = env();
  if (!e.S3_PUBLIC_ENDPOINT || e.S3_PUBLIC_ENDPOINT === e.S3_ENDPOINT) return s3();
  return (publicClient ??= makeClient(e.S3_PUBLIC_ENDPOINT));
}

const bucket = () => env().S3_BUCKET;

const CONTENT_TYPES: Record<string, string> = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".mpd": "application/dash+xml",
  ".m4s": "video/iso.segment",
  ".mp4": "video/mp4",
  ".m4a": "audio/mp4",
  ".ts": "video/mp2t",
  ".aac": "audio/aac",
  ".vtt": "text/vtt",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".json": "application/json",
  ".key": "application/octet-stream",
};

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

export const storage = {
  async putBuffer(key: string, body: Buffer | string, contentType = contentTypeFor(key), cacheControl?: string) {
    await s3().send(
      new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType, CacheControl: cacheControl }),
    );
  },

  async putFile(key: string, file: string, contentType = contentTypeFor(file), cacheControl?: string) {
    const stat = await fsp.stat(file);
    if (stat.size > 64 * 1024 * 1024) {
      await new Upload({
        client: s3(),
        params: { Bucket: bucket(), Key: key, Body: fs.createReadStream(file), ContentType: contentType, CacheControl: cacheControl },
        queueSize: 4,
        partSize: 16 * 1024 * 1024,
      }).done();
    } else {
      await s3().send(
        new PutObjectCommand({
          Bucket: bucket(),
          Key: key,
          Body: await fsp.readFile(file),
          ContentType: contentType,
          CacheControl: cacheControl,
        }),
      );
    }
  },

  async putStream(key: string, body: Readable, contentType: string) {
    await new Upload({
      client: s3(),
      params: { Bucket: bucket(), Key: key, Body: body, ContentType: contentType },
      queueSize: 4,
      partSize: 16 * 1024 * 1024,
    }).done();
  },

  /** Upload a directory recursively under a prefix. Returns the uploaded keys. */
  async putDir(dir: string, prefix: string, cacheControl = "public, max-age=31536000, immutable", concurrency = 8) {
    const files: string[] = [];
    const walk = async (d: string) => {
      for (const entry of await fsp.readdir(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) await walk(full);
        else files.push(full);
      }
    };
    await walk(dir);
    const keys: string[] = [];
    let i = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (i < files.length) {
        const file = files[i++]!;
        const rel = path.relative(dir, file).split(path.sep).join("/");
        const key = `${prefix}/${rel}`;
        const cc = file.endsWith(".m3u8") || file.endsWith(".mpd") ? "public, max-age=60" : cacheControl;
        await storage.putFile(key, file, contentTypeFor(file), cc);
        keys.push(key);
      }
    });
    await Promise.all(workers);
    return keys;
  },

  async get(key: string, range?: string): Promise<GetObjectCommandOutput> {
    return s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key, Range: range }));
  },

  async getBuffer(key: string): Promise<Buffer> {
    const res = await storage.get(key);
    const bytes = await res.Body!.transformToByteArray();
    return Buffer.from(bytes);
  },

  async getText(key: string): Promise<string> {
    const res = await storage.get(key);
    return res.Body!.transformToString("utf8");
  },

  async downloadToFile(key: string, file: string) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const res = await storage.get(key);
    await pipeline(res.Body as Readable, fs.createWriteStream(file));
  },

  async head(key: string) {
    try {
      return await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    } catch (err: any) {
      if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NotFound" || err?.name === "NoSuchKey") return null;
      throw err;
    }
  },

  async exists(key: string) {
    return (await storage.head(key)) !== null;
  },

  async copy(from: string, to: string) {
    await s3().send(
      new CopyObjectCommand({ Bucket: bucket(), Key: to, CopySource: `${bucket()}/${encodeURIComponent(from).replace(/%2F/g, "/")}` }),
    );
  },

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    const out: { key: string; size: number }[] = [];
    let token: string | undefined;
    do {
      const res = await s3().send(
        new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of res.Contents ?? []) out.push({ key: o.Key!, size: o.Size ?? 0 });
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  },

  async deletePrefix(prefix: string) {
    const objects = await storage.list(prefix);
    for (let i = 0; i < objects.length; i += 1000) {
      const chunk = objects.slice(i, i + 1000);
      await s3().send(
        new DeleteObjectsCommand({
          Bucket: bucket(),
          Delete: { Objects: chunk.map((o) => ({ Key: o.key })), Quiet: true },
        }),
      );
    }
    return objects.length;
  },

  async deleteKey(key: string) {
    await s3().send(new DeleteObjectsCommand({ Bucket: bucket(), Delete: { Objects: [{ Key: key }], Quiet: true } }));
  },

  async presignPut(key: string, expiresIn = 3600, contentType?: string) {
    return getSignedUrl(s3Public(), new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }), {
      expiresIn,
    });
  },

  async presignGet(key: string, expiresIn = 3600, opts: { public?: boolean; filename?: string } = {}) {
    return getSignedUrl(
      opts.public === false ? s3() : s3Public(),
      new GetObjectCommand({
        Bucket: bucket(),
        Key: key,
        ResponseContentDisposition: opts.filename ? `attachment; filename="${opts.filename}"` : undefined,
      }),
      { expiresIn },
    );
  },
};

/**
 * Where an asset's original media lives and which range of it belongs to the asset.
 * Clips used to read their parent's master with an offset, so deleting the parent broke the
 * clip's thumbnails, MP4s, captions and master download. Clips now get their own master
 * (just the clip range) at processing time; old clips without one fall back to the parent.
 */
export function masterSource(asset: {
  id: string;
  sourceKey?: string | null;
  input: { url?: string; start_time?: number; end_time?: number }[];
}): { key: string; start: number; end?: number } {
  const clip = asset.input.find((i) => i.url?.startsWith("vela://assets/"));
  if (!clip || asset.sourceKey === `assets/${asset.id}/source`) return { key: `assets/${asset.id}/source`, start: 0 };
  return { key: `assets/${clip.url!.slice("vela://assets/".length)}/source`, start: clip.start_time ?? 0, end: clip.end_time };
}

/* Storage layout, kept in one place so every service agrees. */
export const keys = {
  uploadSource: (uploadId: string) => `uploads/${uploadId}/source`,
  assetSource: (assetId: string) => `assets/${assetId}/source`,
  assetHlsPrefix: (assetId: string) => `assets/${assetId}/hls`,
  assetHlsMaster: (assetId: string) => `assets/${assetId}/hls/master.m3u8`,
  assetDashPrefix: (assetId: string) => `assets/${assetId}/dash`,
  assetDashManifest: (assetId: string) => `assets/${assetId}/dash/manifest.mpd`,
  assetHlsKey: (assetId: string) => `assets/${assetId}/hls/enc.key`,
  assetStoryboard: (assetId: string) => `assets/${assetId}/storyboard/storyboard.jpg`,
  assetStoryboardJson: (assetId: string) => `assets/${assetId}/storyboard/storyboard.json`,
  assetThumbCache: (assetId: string, variant: string) => `assets/${assetId}/thumbs/${variant}`,
  assetPoster: (assetId: string) => `assets/${assetId}/thumbs/poster.jpg`,
  assetStatic: (assetId: string, name: string) => `assets/${assetId}/static/${name}`,
  assetPrefix: (assetId: string) => `assets/${assetId}/`,
  trackVtt: (assetId: string, trackId: string) => `assets/${assetId}/text/${trackId}.vtt`,
  trackAudio: (assetId: string, trackId: string) => `assets/${assetId}/audio/${trackId}`,
  liveSegment: (streamId: string, sessionId: string, name: string) => `live/${streamId}/${sessionId}/${name}`,
};
