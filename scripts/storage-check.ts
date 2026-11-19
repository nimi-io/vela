/**
 * S3 compatibility check: exercises every call packages/core/src/storage.ts makes, through
 * Vela's own `storage` module and client settings, against the configured bucket.
 * Works for Garage, R2, S3... Run from the host:
 *
 *   S3_ENDPOINT=http://127.0.0.1:3900 DATABASE_URL=postgres://unused \
 *     pnpm exec tsx --env-file=.env scripts/storage-check.ts
 *
 * Use a different host for S3_ENDPOINT than S3_PUBLIC_ENDPOINT (127.0.0.1 vs localhost) so the
 * separate public presigning client is exercised, as it is inside Docker.
 * All objects are written under a unique `_storage-check/<run>/` prefix and deleted at the end.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { storage, s3 } from "../packages/core/src/storage.js";
import { env } from "../packages/core/src/env.js";

const run = `_storage-check/${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
const results: { name: string; ok: boolean; detail: string }[] = [];

async function check(name: string, fn: () => Promise<string | void>) {
  const t = Date.now();
  try {
    const detail = (await fn()) ?? "";
    results.push({ name, ok: true, detail: `${detail} (${Date.now() - t} ms)`.trim() });
  } catch (err: any) {
    results.push({ name, ok: false, detail: `${err?.name ?? "Error"}: ${err?.message ?? err}` });
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
const sha = (b: Buffer | Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");

const e = env();
console.log(`bucket=${e.S3_BUCKET} endpoint=${e.S3_ENDPOINT} public=${e.S3_PUBLIC_ENDPOINT || "(same)"} region=${e.S3_REGION} pathStyle=${e.S3_FORCE_PATH_STYLE}`);
console.log(`prefix=${run}/\n`);

const small = crypto.randomBytes(256 * 1024);

await check("PutObject (putBuffer) + content-type/cache-control", async () => {
  await storage.putBuffer(`${run}/small.m3u8`, small, undefined, "public, max-age=60");
  const h = await storage.head(`${run}/small.m3u8`);
  assert(h, "object missing after put");
  assert(h.ContentLength === small.length, `size ${h.ContentLength} != ${small.length}`);
  assert(h.ContentType === "application/vnd.apple.mpegurl", `content-type ${h.ContentType}`);
  assert(h.CacheControl === "public, max-age=60", `cache-control ${h.CacheControl}`);
  return `${small.length} bytes`;
});

await check("GetObject full (getBuffer) round-trip", async () => {
  const b = await storage.getBuffer(`${run}/small.m3u8`);
  assert(sha(b) === sha(small), "content mismatch");
});

await check("GetObject with Range", async () => {
  const res = await storage.get(`${run}/small.m3u8`, "bytes=100-1123");
  const b = Buffer.from(await res.Body!.transformToByteArray());
  assert(res.$metadata.httpStatusCode === 206, `status ${res.$metadata.httpStatusCode}`);
  assert(b.length === 1024, `length ${b.length}`);
  assert(b.equals(small.subarray(100, 1124)), "range bytes mismatch");
  assert(res.ContentRange === `bytes 100-1123/${small.length}`, `Content-Range ${res.ContentRange}`);
  return res.ContentRange;
});

await check("GetObject open-ended Range (bytes=N-)", async () => {
  const res = await storage.get(`${run}/small.m3u8`, `bytes=${small.length - 10}-`);
  const b = Buffer.from(await res.Body!.transformToByteArray());
  assert(b.equals(small.subarray(small.length - 10)), "suffix mismatch");
});

await check("HeadObject on missing key -> null (not found)", async () => {
  const h = await storage.head(`${run}/does-not-exist`);
  assert(h === null, "expected null");
  assert((await storage.exists(`${run}/does-not-exist`)) === false, "exists() should be false");
});

await check("GetObject on missing key -> NoSuchKey", async () => {
  try {
    await storage.get(`${run}/does-not-exist`);
  } catch (err: any) {
    assert(err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404, `got ${err.name}`);
    return err.name;
  }
  throw new Error("expected an error");
});

const big = path.join(os.tmpdir(), `vela-storage-check-${process.pid}.bin`);
let bigSha = "";
await check("Multipart upload (putFile > 64 MB via lib-storage)", async () => {
  const size = 70 * 1024 * 1024 + 12345; // 5 parts at 16 MB, last one short
  const hash = crypto.createHash("sha256");
  const out = fs.createWriteStream(big);
  for (let left = size; left > 0; ) {
    const chunk = crypto.randomBytes(Math.min(left, 4 * 1024 * 1024));
    hash.update(chunk);
    if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
    left -= chunk.length;
  }
  await new Promise<void>((r, j) => out.end((err?: Error) => (err ? j(err) : r())));
  bigSha = hash.digest("hex");
  await storage.putFile(`${run}/big/source`, big, "video/mp4");
  const h = await storage.head(`${run}/big/source`);
  assert(h?.ContentLength === size, `size ${h?.ContentLength} != ${size}`);
  assert(h?.ContentType === "video/mp4", `content-type ${h?.ContentType}`);
  return `${size} bytes, ETag ${h?.ETag}`;
});

await check("downloadToFile (streamed GetObject) of multipart object", async () => {
  const dst = `${big}.down`;
  await storage.downloadToFile(`${run}/big/source`, dst);
  const got = crypto.createHash("sha256").update(await fsp.readFile(dst)).digest("hex");
  await fsp.rm(dst, { force: true });
  assert(got === bigSha, "sha256 mismatch");
});

await check("putStream (multipart from a stream)", async () => {
  await storage.putStream(`${run}/stream.bin`, fs.createReadStream(big), "application/octet-stream");
  const h = await storage.head(`${run}/stream.bin`);
  assert(h?.ContentLength === (await fsp.stat(big)).size, `size ${h?.ContentLength}`);
});

await check("CopyObject (incl. key with spaces/unicode/+)", async () => {
  const odd = `${run}/odd name+ü&(1).bin`;
  await storage.putBuffer(odd, small);
  await storage.copy(odd, `${run}/copied/odd copy.bin`);
  const b = await storage.getBuffer(`${run}/copied/odd copy.bin`);
  assert(sha(b) === sha(small), "copied content mismatch");
  await storage.copy(`${run}/big/source`, `${run}/big/copy`);
  const h = await storage.head(`${run}/big/copy`);
  assert(h?.ContentLength === (await fsp.stat(big)).size, "multipart copy size mismatch");
});

await check("putDir (concurrent uploads, nested dirs)", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vela-putdir-"));
  for (let i = 0; i < 12; i++) {
    await fsp.mkdir(path.join(dir, `v${i % 3}`), { recursive: true });
    await fsp.writeFile(path.join(dir, `v${i % 3}`, `seg_${i}.m4s`), crypto.randomBytes(1024));
  }
  await fsp.writeFile(path.join(dir, "master.m3u8"), "#EXTM3U\n");
  const keys = await storage.putDir(dir, `${run}/hls`);
  await fsp.rm(dir, { recursive: true, force: true });
  assert(keys.length === 13, `uploaded ${keys.length}`);
  const m = await storage.head(`${run}/hls/master.m3u8`);
  assert(m?.CacheControl === "public, max-age=60", `manifest cache-control ${m?.CacheControl}`);
  const s = await storage.head(`${run}/hls/v1/seg_1.m4s`);
  assert(s?.ContentType === "video/iso.segment", `segment content-type ${s?.ContentType}`);
});

await check("ListObjectsV2 with pagination (>1000 keys)", async () => {
  const n = 1105;
  let i = 0;
  await Promise.all(
    Array.from({ length: 32 }, async () => {
      while (i < n) {
        const k = i++;
        await storage.putBuffer(`${run}/many/${String(k).padStart(5, "0")}`, "x");
      }
    }),
  );
  const listed = await storage.list(`${run}/many/`);
  assert(listed.length === n, `listed ${listed.length} of ${n}`);
  assert(new Set(listed.map((o) => o.key)).size === n, "duplicate keys across pages");
  return `${listed.length} keys`;
});

await check("Presigned PUT from outside Docker (S3_PUBLIC_ENDPOINT) with Content-Type", async () => {
  const url = await storage.presignPut(`${run}/presigned/source`, 600, "video/mp4");
  const pub = new URL(e.S3_PUBLIC_ENDPOINT || e.S3_ENDPOINT!);
  assert(new URL(url).host === pub.host, `presigned host ${new URL(url).host} != public ${pub.host}`);
  const res = await fetch(url, { method: "PUT", body: small, headers: { "content-type": "video/mp4" } });
  assert(res.ok, `PUT ${res.status}: ${await res.text()}`);
  const h = await storage.head(`${run}/presigned/source`);
  assert(h?.ContentLength === small.length, "size mismatch after presigned PUT");
  return new URL(url).origin;
});

await check("Presigned PUT without Content-Type (browser may omit it)", async () => {
  const url = await storage.presignPut(`${run}/presigned/nocontenttype`, 600);
  const res = await fetch(url, { method: "PUT", body: small });
  assert(res.ok, `PUT ${res.status}: ${await res.text()}`);
});

await check("Presigned PUT rejects tampered signature", async () => {
  const url = new URL(await storage.presignPut(`${run}/presigned/tamper`, 600));
  url.searchParams.set("X-Amz-Signature", "0".repeat(64));
  const res = await fetch(url, { method: "PUT", body: small });
  assert(res.status === 403, `expected 403, got ${res.status}`);
});

await check("Presigned GET (public) with attachment filename (MP4 download)", async () => {
  // Browsers download with a plain GET, so the override must apply to the 200 response.
  const url = await storage.presignGet(`${run}/small.m3u8`, 600, { filename: "my video.mp4" });
  const res = await fetch(url);
  const b = Buffer.from(await res.arrayBuffer());
  assert(res.status === 200, `status ${res.status}`);
  assert(sha(b) === sha(small), "bytes mismatch");
  const cd = res.headers.get("content-disposition");
  assert(cd === 'attachment; filename="my video.mp4"', `content-disposition ${cd}`);
});

await check("Presigned GET (public) with Range (redirect-mode segments)", async () => {
  const url = await storage.presignGet(`${run}/small.m3u8`, 600);
  const res = await fetch(url, { headers: { range: "bytes=0-99" } });
  const b = Buffer.from(await res.arrayBuffer());
  assert(res.status === 206, `status ${res.status}`);
  assert(b.equals(small.subarray(0, 100)), "bytes mismatch");
  // Garage quirk: response-content-* overrides are not applied to 206 responses (AWS/R2 do).
  return `content-disposition on 206: ${res.headers.get("content-disposition") ?? "(not applied)"}`;
});

await check("Presigned GET (internal client, public:false)", async () => {
  const url = await storage.presignGet(`${run}/small.m3u8`, 600, { public: false });
  assert(new URL(url).host === new URL(e.S3_ENDPOINT!).host, "internal presign should use S3_ENDPOINT");
  const res = await fetch(url);
  assert(res.ok, `status ${res.status}`);
});

await check("Presigned GET expired -> refused", async () => {
  const url = await storage.presignGet(`${run}/small.m3u8`, 1);
  await new Promise((r) => setTimeout(r, 2500));
  const res = await fetch(url);
  // AWS/R2 answer 403 AccessDenied; Garage answers 400 InvalidRequest "Date is too old".
  assert(res.status === 400 || res.status === 403, `expected 400/403, got ${res.status}`);
  const code = (await res.text()).match(/<Code>([^<]+)/)?.[1];
  return `${res.status} ${code}`;
});

await check("deleteKey", async () => {
  await storage.deleteKey(`${run}/stream.bin`);
  assert(!(await storage.exists(`${run}/stream.bin`)), "still exists");
});

await check("DeleteObjects (deletePrefix, >1000 keys in chunks)", async () => {
  const n = await storage.deletePrefix(`${run}/`);
  const left = await storage.list(`${run}/`);
  assert(left.length === 0, `${left.length} objects left`);
  return `${n} deleted`;
});

await fsp.rm(big, { force: true });
s3().destroy();

const w = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(w)}  ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
