#!/usr/bin/env node
/**
 * Configures CORS on the storage bucket so browsers can PUT direct uploads and fetch media.
 * Works with Garage (the local default), Cloudflare R2, AWS S3, Backblaze B2, Wasabi.
 *
 * Runs from the host, so it talks to S3_PUBLIC_ENDPOINT when set (S3_ENDPOINT is often a
 * docker-internal hostname such as http://garage:3900). Override with S3_SETUP_ENDPOINT.
 *
 *   node --env-file=.env scripts/setup-bucket.mjs [--origins https://app.example.com,https://admin.example.com]
 *     [--playback-origins https://www.example.com]
 *
 * --origins           pages allowed to PUT direct uploads (the dashboard, your app). Default: any.
 * --playback-origins  pages allowed to read media straight from the bucket, which players do with
 *                     STREAM_SEGMENT_MODE=redirect (the stream service answers segment requests with
 *                     a 302 to a presigned URL). Default: any, because players are embedded on
 *                     arbitrary sites and a browser that follows a cross-origin redirect sends
 *                     "Origin: null". This only lets pages read responses; every object still needs
 *                     a presigned URL. Restricting it breaks playback in redirect mode for other pages.
 */
import { S3Client, PutBucketCorsCommand, HeadBucketCommand, CreateBucketCommand } from "@aws-sdk/client-s3";

const list = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1].split(",") : fallback;
};
const origins = list("--origins", ["*"]);
const playbackOrigins = list("--playback-origins", ["*"]);
const e = process.env;
for (const k of ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) {
  if (!e[k]) {
    console.error(`${k} is not set (run with --env-file=.env)`);
    process.exit(1);
  }
}

const endpoint = e.S3_SETUP_ENDPOINT || e.S3_PUBLIC_ENDPOINT || e.S3_ENDPOINT || undefined;
const s3 = new S3Client({
  region: e.S3_REGION ?? "auto",
  endpoint,
  forcePathStyle: (e.S3_FORCE_PATH_STYLE ?? "true") === "true",
  credentials: { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY },
});

try {
  await s3.send(new HeadBucketCommand({ Bucket: e.S3_BUCKET }));
} catch {
  console.log(`Bucket ${e.S3_BUCKET} not found, creating it`);
  await s3.send(new CreateBucketCommand({ Bucket: e.S3_BUCKET }));
}

await s3.send(
  new PutBucketCorsCommand({
    Bucket: e.S3_BUCKET,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedOrigins: origins,
          AllowedMethods: ["GET", "HEAD", "PUT"],
          AllowedHeaders: ["*"],
          ExposeHeaders: ["ETag", "Content-Length", "Content-Range"],
          MaxAgeSeconds: 3600,
        },
        {
          // Playback in STREAM_SEGMENT_MODE=redirect: segments, init segments, keys and text tracks.
          AllowedOrigins: playbackOrigins,
          AllowedMethods: ["GET", "HEAD"],
          AllowedHeaders: ["*"],
          ExposeHeaders: ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
          MaxAgeSeconds: 3600,
        },
      ],
    },
  }),
);
console.log(
  `CORS configured on ${e.S3_BUCKET} (${endpoint ?? "AWS S3"}): uploads from ${origins.join(", ")}; playback from ${playbackOrigins.join(", ")}`,
);
