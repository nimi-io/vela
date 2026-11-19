#!/usr/bin/env node
/**
 * End-to-end smoke test against a running Vela deployment.
 *
 *   node scripts/smoke-test.mjs --video ./sample.mp4 \
 *     [--api http://localhost:4000] [--stream http://localhost:4100] [--webhook-port 4900]
 *
 * Signs up a throwaway user, uploads a video, waits for encoding, then checks HLS playback,
 * signed playback, AES-128, thumbnails, storyboards, clips, MP4 downloads, webhooks and analytics.
 * --webhook-host sets the host the API should call back on (default localhost). The same local
 * server also serves the test video at /source.mp4 for the import-from-URL check, so containers
 * must be able to reach it there (e.g. --webhook-host host.docker.internal).
 */
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { SignJWT, importPKCS8 } from "jose";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith("--") ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);
const API = args.api ?? "http://localhost:4000";
const STREAM = args.stream ?? "http://localhost:4100";
const VIDEO = args.video;
const HOOK_PORT = Number(args["webhook-port"] ?? 4900);
const HOOK_HOST = args["webhook-host"] ?? "localhost";
if (!VIDEO || !fs.existsSync(VIDEO)) {
  console.error("Pass --video <path to a short video file>");
  process.exit(2);
}

let cookie = "";
let envId = "";
let failures = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "✔" : "✘"} ${name}${extra ? `  ${extra}` : ""}`);
  if (!cond) failures++;
  return cond;
};

async function call(method, path, body, headers = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(envId ? { "X-Vela-Environment": envId } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return json?.data ?? json;
}

async function waitFor(fn, label, timeoutMs = 240_000, interval = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// Webhook receiver. Each run listens on its own path so retried deliveries from earlier runs
// (signed with an older endpoint's secret) aren't mistaken for this run's events.
const RUN = crypto.randomBytes(6).toString("hex");
const HOOK_PATH = `/hook/${RUN}`;
const hooks = [];
let hookSecret = "";
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/source.mp4") {
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": fs.statSync(VIDEO).size });
    fs.createReadStream(VIDEO).pipe(res);
    return;
  }
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (req.url !== HOOK_PATH) return res.writeHead(410).end("gone"); // stale endpoint from an earlier run
    const sig = String(req.headers["vela-signature"] ?? "");
    const { t, v1 } = Object.fromEntries(sig.split(",").map((p) => p.split("=")));
    const expected = crypto.createHmac("sha256", hookSecret).update(`${t}.${body}`).digest("hex");
    hooks.push({ ...JSON.parse(body), _valid: expected === v1 });
    res.writeHead(200).end("ok");
  });
});
await new Promise((r) => server.listen(HOOK_PORT, r));

try {
  const email = `smoke-${Date.now()}@example.com`;
  const me = await call("POST", "/auth/signup", { email, password: "smoke-test-password", name: "Smoke Test" });
  envId = me.organizations[0].environments[0].id;
  ok("sign up + session", !!cookie && !!envId);

  const key = await call("POST", "/v1/api-keys", { name: "smoke" });
  const basic = `Basic ${Buffer.from(`${key.id}:${key.secret}`).toString("base64")}`;
  const viaKey = await fetch(`${API}/v1/assets`, { headers: { Authorization: basic } });
  ok("API key auth", viaKey.ok);

  const hook = await call("POST", "/v1/webhooks", { url: `http://${HOOK_HOST}:${HOOK_PORT}${HOOK_PATH}`, events: ["*"] });
  hookSecret = hook.secret;

  // Direct upload
  const up = await call("POST", "/v1/uploads", { new_asset_settings: { playback_policies: ["public"], mp4_support: "capped-1080p", title: "Smoke test" } });
  const put = await fetch(up.url, { method: "PUT", body: fs.readFileSync(VIDEO) });
  ok("PUT to presigned upload URL", put.ok, `HTTP ${put.status}`);
  const done = await call("POST", `/v1/uploads/${up.id}/complete`);
  ok("upload → asset created", !!done.asset_id);

  const asset = await waitFor(async () => {
    const a = await call("GET", `/v1/assets/${done.asset_id}`);
    if (a.status === "errored") throw new Error(`asset errored: ${JSON.stringify(a.errors)}`);
    return a.status === "ready" ? a : null;
  }, "asset ready");
  ok("asset ready", true, `${asset.duration?.toFixed(1)}s, renditions ${asset.renditions.map((r) => r.name).join(",")}`);
  const pid = asset.playback_ids[0].id;

  // HLS
  const master = await (await fetch(`${STREAM}/${pid}.m3u8`)).text();
  ok("master playlist", master.startsWith("#EXTM3U") && master.includes("EXT-X-STREAM-INF"));
  const variant = master.split("\n").find((l) => l && !l.startsWith("#"));
  const media = await (await fetch(`${STREAM}${variant}`)).text();
  ok("media playlist", media.includes("#EXTINF"));
  const base = variant.slice(0, variant.lastIndexOf("/") + 1);
  const init = media.match(/URI="([^"]+)"/)?.[1];
  const seg = media.split("\n").find((l) => l && !l.startsWith("#"));
  const segRes = await fetch(`${STREAM}${base}${seg}`);
  ok("segment download", segRes.ok && (await segRes.arrayBuffer()).byteLength > 1000);
  if (init) ok("init segment", (await fetch(`${STREAM}${base}${init}`)).ok);
  const range = await fetch(`${STREAM}${base}${seg}`, { headers: { Range: "bytes=0-99" } });
  ok("range requests", range.status === 206);

  // Images
  const thumb = await fetch(`${STREAM}/${pid}/thumbnail.jpg?time=2&width=320`);
  ok("thumbnail at time", thumb.ok && thumb.headers.get("content-type") === "image/jpeg");
  ok("poster", (await fetch(`${STREAM}/${pid}/thumbnail.jpg`)).ok);
  ok("animated gif", (await fetch(`${STREAM}/${pid}/animated.gif?start=0&end=2&width=160`)).ok);
  ok("storyboard vtt", (await (await fetch(`${STREAM}/${pid}/storyboard.vtt`)).text()).includes("#xywh="));
  ok("embed page", (await (await fetch(`${STREAM}/embed/${pid}`)).text()).includes("vela-player"));
  ok("player bundle", (await fetch(`${STREAM}/player.js`)).ok);

  // Signed playback
  const sk = await call("POST", "/v1/signing-keys");
  const signedPid = await call("POST", `/v1/assets/${asset.id}/playback-ids`, { policy: "signed" });
  const denied = await fetch(`${STREAM}/${signedPid.id}.m3u8`);
  ok("signed: denied without token", denied.status === 403);
  const pk = await importPKCS8(Buffer.from(sk.private_key, "base64").toString(), "RS256");
  const jwt = await new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: sk.id }).setSubject(signedPid.id).setAudience("v").setExpirationTime("1h").sign(pk);
  const signed = await fetch(`${STREAM}/${signedPid.id}.m3u8?token=${jwt}`);
  const signedText = await signed.text();
  ok("signed: plays with token", signed.ok && signedText.includes("EXT-X-STREAM-INF"));
  const sv = signedText.split("\n").find((l) => l && !l.startsWith("#"));
  ok("signed: rendition authorised by path token", (await fetch(`${STREAM}${sv}`)).ok);
  const tampered = sv.replace(/\/(\d+)\.([0-9a-f]+)\//, (_m, e, s) => `/${e}.${s.replace(/.$/, s.endsWith("0") ? "1" : "0")}/`);
  ok("signed: tampered path token rejected", (await fetch(`${STREAM}${tampered}`)).status === 403);

  // Static MP4
  await waitFor(async () => (await call("GET", `/v1/assets/${asset.id}`)).static_renditions?.status === "ready", "mp4", 180_000);
  const mp4 = await waitFor(async () => {
    const r = await fetch(`${STREAM}/${pid}/capped-1080p.mp4`, { redirect: "manual" });
    return r.status === 302 ? r : null;
  }, "mp4 redirect", 20_000, 1000).catch(() => null);
  ok("mp4 download redirect", !!mp4);
  const dl = mp4 ? await fetch(mp4.headers.get("location")) : null;
  const dlBytes = dl?.ok ? (await dl.arrayBuffer()).byteLength : 0;
  ok("mp4 download from storage", !!dl?.ok && dlBytes > 10_000 && dl.headers.get("content-type") === "video/mp4", `HTTP ${dl?.status}, ${dlBytes} bytes`);

  // Clip
  const clip = await call("POST", `/v1/assets/${asset.id}/clips`, { start_time: 1, end_time: 4 });
  const clipReady = await waitFor(async () => {
    const a = await call("GET", `/v1/assets/${clip.id}`);
    if (a.status === "errored") throw new Error(`clip errored: ${JSON.stringify(a.errors)}`);
    return a.status === "ready" ? a : null;
  }, "clip ready");
  ok("clip", Math.abs(clipReady.duration - 3) < 0.6, `${clipReady.duration?.toFixed(2)}s`);

  // AES-128
  // Import from URL with AES-128 encryption. The URL must be reachable from the worker container:
  // presigned storage URLs use S3_PUBLIC_ENDPOINT (e.g. localhost:3900), which is only valid
  // outside Docker, so the test serves the video itself.
  const aes = await call("POST", "/v1/assets", { input: `http://${HOOK_HOST}:${HOOK_PORT}/source.mp4`, playback_policies: ["public"], protection: "aes-128" });
  const aesReady = await waitFor(async () => {
    const a = await call("GET", `/v1/assets/${aes.id}`);
    if (a.status === "errored") throw new Error(`aes asset errored: ${JSON.stringify(a.errors)}`);
    return a.status === "ready" ? a : null;
  }, "aes ready");
  const am = await (await fetch(`${STREAM}/${aesReady.playback_ids[0].id}.m3u8`)).text();
  const av = am.split("\n").find((l) => l && !l.startsWith("#"));
  const amedia = await (await fetch(`${STREAM}${av}`)).text();
  const keyUri = amedia.match(/METHOD=AES-128,URI="([^"]+)"/)?.[1];
  ok("aes-128 playlist has key", !!keyUri);
  const keyRes = keyUri ? await fetch(`${STREAM}${keyUri}`) : null;
  ok("aes-128 key served", !!keyRes?.ok && (await keyRes.arrayBuffer()).byteLength === 16);

  // Analytics
  const viewId = crypto.randomBytes(12).toString("hex");
  const beacon = (extra) =>
    fetch(`${STREAM}/data/events`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15" },
      body: JSON.stringify({ view_id: viewId, playback_id: pid, viewer_id: "smoke", startup_ms: 640, ...extra }),
    });
  await beacon({ event: "viewstart", watch_time_ms: 1000 });
  await beacon({ event: "heartbeat", watch_time_ms: 9000, rebuffer_count: 1, rebuffer_ms: 400 });
  const overview = await call("GET", "/v1/data/overview?timeframe=24h");
  ok("analytics recorded", overview.views >= 1 && overview.watch_time_seconds >= 9, `score ${Math.round(overview.experience_score)}`);
  const bd = await call("GET", "/v1/data/breakdown?dimension=browser&timeframe=24h");
  ok("analytics breakdown", bd.some((r) => r.value === "Safari"));

  // Live stream API
  const live = await call("POST", "/v1/live-streams", { playback_policies: ["public"], title: "Smoke live" });
  ok("live stream created", !!live.stream_key && live.ingest.rtmp.url.startsWith("rtmp"));

  // Webhooks
  await waitFor(() => hooks.some((h) => h.type === "video.asset.ready"), "webhook", 30_000, 1000);
  ok("webhook delivered", hooks.some((h) => h.type === "video.asset.ready"));
  ok("webhook signatures valid", hooks.length > 0 && hooks.every((h) => h._valid), `${hooks.length} events`);

  // Delete
  const clipPid = clipReady.playback_ids[0].id;
  ok("clip plays before delete", (await fetch(`${STREAM}/${clipPid}.m3u8`)).ok);
  await call("DELETE", `/v1/assets/${clip.id}`);
  // Must be well under the stream service's 15 s lookup cache: deletes are pushed to every replica.
  const gone = await waitFor(async () => (await fetch(`${STREAM}/${clipPid}.m3u8`)).status === 404, "deleted playback 404", 3_000, 250).catch(() => false);
  ok("delete asset → playback 404 within 3 s", gone);

  // Revoking a signing key must stop new playback quickly (the stream caches keys for 60 s).
  const jwt2 = await new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: sk.id }).setSubject(signedPid.id).setAudience("v").setExpirationTime("1h").sign(pk);
  ok("signed: plays before key revoked", (await fetch(`${STREAM}/${signedPid.id}.m3u8?token=${jwt2}`)).ok);
  await call("DELETE", `/v1/signing-keys/${sk.id}`);
  const revoked = await waitFor(async () => (await fetch(`${STREAM}/${signedPid.id}.m3u8?token=${jwt2}`)).status === 403, "revoked key 403", 3_000, 250).catch(() => false);
  ok("signed: revoked key rejected within 3 s", revoked);
} catch (err) {
  console.error("✘", err.message);
  failures++;
} finally {
  server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
