import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { Readable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { env, storage, keys, createLogger, getContentKey, getDrmSettings, redis } from "@vela/core";
import { getDb, sql } from "@vela/db";
import {
  resolvePlayback,
  verifyToken,
  pathToken,
  checkPathToken,
  PlaybackError,
  type Resolved,
  type Audience,
} from "./lib/playback.js";
import {
  rewriteMaster,
  rewriteMediaKey,
  rewriteLiveMaster,
  rewriteMpd,
  subtitlePlaylist,
  storyboardVtt,
  chaptersVtt,
} from "./lib/manifest.js";
import { thumbnail, animated } from "./lib/images.js";
import { license, fairplayCertificate, type DrmSystem } from "./lib/license.js";
import { beaconSchema, recordBeacon } from "./lib/analytics.js";
import { embedHtml } from "./embed.js";
import { TtlCache } from "./lib/cache.js";

const log = createLogger("stream");
const bin = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength) as Uint8Array<ArrayBuffer>;
const textCache = new TtlCache<string>(60_000, 2000);

const RES: Record<string, number> = { "270p": 270, "360p": 360, "480p": 480, "540p": 540, "720p": 720, "1080p": 1080, "1440p": 1440, "2160p": 2160 };

function q(c: Context) {
  return c.req.query() as Record<string, string>;
}

async function authorise(c: Context, r: Resolved, aud: Audience) {
  return verifyToken(r, c.req.query("token"), aud);
}

/** Streams an object from storage (supports Range) or redirects to a presigned URL. */
async function serveObject(c: Context, key: string, cacheControl: string) {
  if (env().STREAM_SEGMENT_MODE === "redirect") {
    return c.redirect(await storage.presignGet(key, 3600), 302);
  }
  const range = c.req.header("range");
  let obj;
  try {
    obj = await storage.get(key, range);
  } catch (err: any) {
    const code = err?.$metadata?.httpStatusCode;
    if (code === 404 || err?.name === "NoSuchKey") return c.text("Not found", 404);
    if (code === 416) return c.text("Range not satisfiable", 416);
    throw err;
  }
  const headers: Record<string, string> = {
    "Content-Type": obj.ContentType ?? "application/octet-stream",
    "Cache-Control": cacheControl,
    "Accept-Ranges": "bytes",
  };
  if (obj.ContentLength !== undefined) headers["Content-Length"] = String(obj.ContentLength);
  if (obj.ContentRange) headers["Content-Range"] = obj.ContentRange;
  if (obj.ETag) headers.ETag = obj.ETag;
  if (c.req.method === "HEAD") {
    (obj.Body as Readable).destroy?.();
    return new Response(null, { status: obj.ContentRange ? 206 : 200, headers });
  }
  return new Response(Readable.toWeb(obj.Body as Readable) as ReadableStream, { status: obj.ContentRange ? 206 : 200, headers });
}

async function cachedText(key: string, ttl = 60_000) {
  return textCache.getOr(key, () => storage.getText(key), ttl);
}

function requireAsset(r: Resolved) {
  if (!r.asset) throw new PlaybackError(404, "Not an asset playback ID");
  if (r.asset.status === "errored") throw new PlaybackError(410, "Asset failed to process");
  if (r.asset.status !== "ready") throw new PlaybackError(412, "Asset is still processing");
  return r.asset;
}

function manifestCache(r: Resolved) {
  return r.policy === "public" ? "public, max-age=60" : "private, max-age=60";
}

/* ------------------------------- Masters ------------------------------- */

async function hlsMaster(c: Context, r: Resolved) {
  const claims = await authorise(c, r, "v");
  const st = pathToken(r, claims);
  const base = `/${r.playbackId}/${st}`;

  if (r.live) {
    const live = r.live;
    if (!live.connected) {
      return c.json({ error: { type: "live_stream_inactive", messages: ["This live stream is not active"] } }, 412, { "Cache-Control": "no-cache" });
    }
    let text: string | null = null;
    for (let i = 0; i < 6 && text === null; i++) {
      const res = await mediamtx(`/live/${live.streamKey}/index.m3u8`);
      if (res.ok) text = await res.text();
      else await new Promise((res) => setTimeout(res, 500));
    }
    if (text === null) return c.json({ error: { type: "live_stream_starting", messages: ["Live stream is starting, retry shortly"] } }, 503, { "Retry-After": "2" });
    return c.body(rewriteLiveMaster(text, `${base}/live/`), 200, {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-cache",
    });
  }

  const asset = requireAsset(r);
  const master = await cachedText(keys.assetHlsMaster(asset.id));
  const maxRes = RES[c.req.query("max_resolution") ?? ""] ?? (typeof claims?.max_resolution === "string" ? RES[claims.max_resolution] : undefined);
  const minRes = RES[c.req.query("min_resolution") ?? ""];
  const body = rewriteMaster(master, `${base}/hls/`, {
    maxShortSide: maxRes,
    minShortSide: minRes,
    subtitles: asset.textTracks.map((t) => ({
      id: t.id,
      name: t.name ?? t.languageCode ?? "Subtitles",
      language: t.languageCode ?? "und",
      closedCaptions: t.closedCaptions,
    })),
    subtitleUri: (id) => `${base}/subs/${id}.m3u8`,
  });
  return c.body(body, 200, { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": manifestCache(r) });
}

async function dashManifest(c: Context, r: Resolved) {
  const claims = await authorise(c, r, "v");
  const asset = requireAsset(r);
  if (!asset.hasDash) throw new PlaybackError(404, "DASH is only produced for DRM assets; use .m3u8");
  const st = pathToken(r, claims);
  const mpd = await cachedText(keys.assetDashManifest(asset.id));
  // The MPD references the CMAF segments shared with HLS, relative to hls/ (see drmPackagerArgs).
  return c.body(rewriteMpd(mpd, `/${r.playbackId}/${st}/hls/`), 200, {
    "Content-Type": "application/dash+xml",
    "Cache-Control": manifestCache(r),
  });
}

/* ------------------------------- Live proxy ------------------------------- */

function mediamtx(p: string, search = "") {
  const e = env();
  return fetch(`${e.MEDIAMTX_HLS_URL}${p}${search}`, {
    headers: { Authorization: `Basic ${Buffer.from(`internal:${e.INTERNAL_SECRET}`).toString("base64")}` },
    signal: AbortSignal.timeout(20_000), // LL-HLS blocking playlist reloads can hold ~a few seconds
  });
}

async function liveProxy(c: Context, r: Resolved, rest: string) {
  if (!r.live?.connected) return c.text("Live stream is not active", 412);
  if (!/^[A-Za-z0-9_.\-]+$/.test(rest)) return c.text("Bad path", 400);
  const url = new URL(c.req.url);
  const res = await mediamtx(`/live/${r.live.streamKey}/${rest}`, url.search);
  const headers: Record<string, string> = {
    "Content-Type": res.headers.get("content-type") ?? "application/octet-stream",
    "Cache-Control": rest.endsWith(".m3u8") ? "no-cache" : "public, max-age=60",
  };
  return new Response(res.body, { status: res.status, headers });
}

/* --------------------------------- App --------------------------------- */

export function createApp() {
  const app = new Hono();

  app.use("*", cors({ origin: "*", allowMethods: ["GET", "HEAD", "POST", "OPTIONS"], allowHeaders: ["Content-Type", "Range"], exposeHeaders: ["Content-Length", "Content-Range"] }));

  app.onError((err, c) => {
    if (err instanceof PlaybackError) return c.json({ error: { type: "playback_error", messages: [err.message] } }, err.status as any);
    log.error({ err: err.message, path: c.req.path }, "stream error");
    return c.json({ error: { type: "internal_error", messages: ["Something went wrong"] } }, 500);
  });

  app.get("/health", async (c) => {
    try {
      await getDb().execute(sql`select 1`);
      await redis().ping();
      return c.json({ status: "ok" });
    } catch (err) {
      return c.json({ status: "degraded", error: String(err) }, 503);
    }
  });

  /* Player assets + embed page */
  const playerDist = process.env.PLAYER_DIST ?? path.resolve(process.cwd(), "../../packages/player/dist");
  app.get("/player.js", (c) => {
    const f = path.join(playerDist, "vela-player.js");
    if (!fs.existsSync(f)) return c.text("// player bundle not built: run `pnpm --filter @vela/player build`", 404);
    return c.body(bin(fs.readFileSync(f)), 200, { "Content-Type": "application/javascript", "Cache-Control": "public, max-age=300" });
  });
  app.get("/embed/:pid", async (c) => {
    const r = await resolvePlayback(c.req.param("pid"));
    return c.html(embedHtml(r, q(c)), 200, { "Cache-Control": "public, max-age=60" });
  });

  /* Analytics beacons (navigator.sendBeacon posts text/plain) */
  app.post("/data/events", async (c) => {
    let parsed;
    try {
      parsed = beaconSchema.safeParse(JSON.parse(await c.req.text()));
    } catch {
      return c.body(null, 400);
    }
    if (!parsed.success) return c.body(null, 400);
    const events = "events" in parsed.data ? parsed.data.events : [parsed.data];
    const ctx = {
      ua: c.req.header("user-agent") ?? "",
      country: c.req.header("cf-ipcountry") ?? c.req.header("x-vercel-ip-country") ?? c.req.header("x-country-code") ?? undefined,
    };
    for (const e of events) await recordBeacon(e, ctx).catch((err) => log.warn({ err: err.message }, "beacon failed"));
    return c.body(null, 204);
  });

  /* DRM licenses */
  app.get("/license/fairplay/:pid/cert", async (c) => {
    const r = await resolvePlayback(c.req.param("pid"));
    const cert = await fairplayCertificate(r);
    return c.body(bin(cert), 200, { "Content-Type": "application/octet-stream", "Cache-Control": "public, max-age=3600" });
  });
  app.post("/license/:system/:pid", async (c) => {
    const system = c.req.param("system") as DrmSystem;
    if (!["widevine", "playready", "fairplay", "clearkey"].includes(system)) return c.text("Unknown DRM system", 404);
    const r = await resolvePlayback(c.req.param("pid"));
    if (r.policy !== "drm") throw new PlaybackError(403, "Playback ID does not use the drm policy");
    const claims = await verifyToken(r, c.req.query("token"), "d");
    const out = await license(system, r, claims, await c.req.arrayBuffer(), c.req.header("content-type"));
    return c.body(typeof out.body === "string" ? out.body : bin(out.body), 200, { "Content-Type": out.type, "Cache-Control": "no-store" });
  });

  /* Everything else is playback: /PID.m3u8, /PID/thumbnail.jpg, /PID/TOKEN/hls/... */
  const playback = async (c: Context) => {
    const parts = c.req.path.split("/").filter(Boolean);
    if (parts.length === 0) return c.json({ name: "vela-stream" });

    // Masters
    if (parts.length === 1) {
      const m = parts[0]!.match(/^([A-Za-z0-9]+)\.(m3u8|mpd)$/);
      if (!m) return c.text("Not found", 404);
      const r = await resolvePlayback(m[1]!);
      return m[2] === "m3u8" ? hlsMaster(c, r) : dashManifest(c, r);
    }

    const r = await resolvePlayback(parts[0]!);

    // Images, storyboards, info, static renditions
    if (parts.length === 2) {
      const file = parts[1]!;
      let m;
      if ((m = file.match(/^thumbnail\.(jpg|png|webp)$/))) {
        await authorise(c, r, "t");
        if (r.asset) requireAsset(r);
        const img = await thumbnail(r, m[1] as any, q(c));
        return c.body(bin(img.body), 200, { "Content-Type": img.type, "Cache-Control": `${r.policy === "public" ? "public" : "private"}, max-age=${img.cache}` });
      }
      if ((m = file.match(/^animated\.(gif|webp)$/))) {
        await authorise(c, r, "g");
        requireAsset(r);
        const img = await animated(r, m[1] as any, q(c));
        return c.body(bin(img.body), 200, { "Content-Type": img.type, "Cache-Control": `${r.policy === "public" ? "public" : "private"}, max-age=86400` });
      }
      if ((m = file.match(/^storyboard\.(jpg|vtt|json)$/))) {
        await authorise(c, r, "s");
        const asset = requireAsset(r);
        if (!asset.hasStoryboard) throw new PlaybackError(404, "No storyboard for this asset");
        if (m[1] === "jpg") return serveObject(c, keys.assetStoryboard(asset.id), "public, max-age=86400");
        const sb = JSON.parse(await cachedText(keys.assetStoryboardJson(asset.id), 3600_000));
        const ratio = asset.maxWidth && asset.maxHeight ? asset.maxHeight / asset.maxWidth : 9 / 16;
        const tileHeight = Math.max(2, Math.round((sb.tileWidth * ratio) / 2) * 2);
        const tokenQs = c.req.query("token") ? `?token=${encodeURIComponent(c.req.query("token")!)}` : "";
        const image = `${env().STREAM_PUBLIC_URL}/${r.playbackId}/storyboard.jpg${tokenQs}`;
        if (m[1] === "vtt") {
          return c.body(storyboardVtt(sb, tileHeight, image, asset.duration ?? 0), 200, { "Content-Type": "text/vtt", "Cache-Control": manifestCache(r) });
        }
        return c.json({
          url: image,
          tile_width: sb.tileWidth,
          tile_height: tileHeight,
          duration: asset.duration,
          tiles: Array.from({ length: sb.count }, (_, i) => ({ start: i * sb.interval, x: (i % sb.cols) * sb.tileWidth, y: Math.floor(i / sb.cols) * tileHeight })),
        });
      }
      if (file === "chapters.vtt") {
        await authorise(c, r, "v");
        const asset = requireAsset(r);
        return c.body(chaptersVtt(asset.ai?.chapters ?? [], asset.duration ?? 0), 200, { "Content-Type": "text/vtt", "Cache-Control": "public, max-age=300" });
      }
      if (file === "playback-info") {
        await authorise(c, r, "v");
        return c.json(await playbackInfo(r, c.req.query("token")));
      }
      if ((m = file.match(/^([a-z0-9-]+\.(mp4|m4a))$/))) {
        await authorise(c, r, "v");
        const asset = requireAsset(r);
        if (asset.protection === "drm") throw new PlaybackError(403, "Downloads are disabled for DRM assets");
        const rend = asset.staticRenditions.find((s) => s.name === m![1] && s.status === "ready");
        if (!rend) throw new PlaybackError(404, "Static rendition not available (enable mp4_support)");
        const filename = c.req.query("download");
        return c.redirect(
          await storage.presignGet(keys.assetStatic(asset.id, rend.name), 3600, { filename: filename ? `${filename.replace(/[^\w.\- ]/g, "")}.${rend.ext}` : undefined }),
          302,
        );
      }
      return c.text("Not found", 404);
    }

    // Tokenised paths: /PID/ST/<kind>/...
    const st = parts[1]!;
    checkPathToken(r, st);
    const kind = parts[2];
    const rest = parts.slice(3).join("/");

    if (kind === "live") return liveProxy(c, r, rest);

    const asset = requireAsset(r);
    if (kind === "hls" || kind === "dash") {
      if (!/^[A-Za-z0-9_\-]+(\/[A-Za-z0-9_\-.]+)*$/.test(rest) || rest.includes("..")) return c.text("Bad path", 400);
      const key = `${kind === "hls" ? keys.assetHlsPrefix(asset.id) : keys.assetDashPrefix(asset.id)}/${rest}`;
      if (rest.endsWith(".m3u8")) {
        let text = await cachedText(key, 300_000).catch(() => null);
        if (text === null) return c.text("Not found", 404);
        if (asset.protection === "aes-128") text = rewriteMediaKey(text, `/${r.playbackId}/${st}/key`);
        return c.body(text, 200, { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "public, max-age=3600" });
      }
      if (rest.endsWith(".key") || rest === "enc.key") return c.text("Not found", 404);
      return serveObject(c, key, "public, max-age=31536000, immutable");
    }
    if (kind === "subs") {
      const id = rest.replace(/\.m3u8$/, "");
      const t = asset.textTracks.find((x) => x.id === id);
      if (!t) return c.text("Not found", 404);
      return c.body(subtitlePlaylist(`/${r.playbackId}/${st}/text/${t.id}.vtt`, asset.duration ?? 0), 200, {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "public, max-age=300",
      });
    }
    if (kind === "text") {
      const id = rest.replace(/\.vtt$/, "");
      const t = asset.textTracks.find((x) => x.id === id);
      if (!t?.storageKey) return c.text("Not found", 404);
      return serveObject(c, t.storageKey, "public, max-age=300");
    }
    if (kind === "key") {
      if (asset.protection !== "aes-128") return c.text("Not found", 404);
      const k = await getContentKey(asset.id);
      if (!k) return c.text("Not found", 404);
      return c.body(bin(Buffer.from(k.key, "hex")), 200, { "Content-Type": "application/octet-stream", "Cache-Control": "private, max-age=3600" });
    }
    return c.text("Not found", 404);
  };
  app.get("*", playback);
  app.on("HEAD", "*", playback);

  return app;
}

/** What the player needs to know before loading (protection, DRM endpoints, tracks...). */
async function playbackInfo(r: Resolved, token?: string) {
  const e = env();
  const base = e.STREAM_PUBLIC_URL;
  const tq = token ? `?token=${encodeURIComponent(token)}` : "";
  if (r.live) {
    return { type: "live", policy: r.policy, status: r.live.connected ? "active" : "idle", title: r.live.title, hls: `${base}/${r.playbackId}.m3u8${tq}` };
  }
  const a = r.asset!;
  let drm: Record<string, unknown> | null = null;
  if (a.protection === "drm") {
    const s = await getDrmSettings(r.environmentId);
    drm =
      s.provider === "clearkey"
        ? { provider: "clearkey", clearkey: `${base}/license/clearkey/${r.playbackId}` }
        : {
            provider: "proxy",
            widevine: s.widevine_license_url ? `${base}/license/widevine/${r.playbackId}` : null,
            playready: s.playready_license_url ? `${base}/license/playready/${r.playbackId}` : null,
            fairplay: s.fairplay_license_url ? `${base}/license/fairplay/${r.playbackId}` : null,
            fairplay_certificate: s.fairplay_certificate_url ? `${base}/license/fairplay/${r.playbackId}/cert` : null,
          };
  }
  return {
    type: "asset",
    policy: r.policy,
    status: a.status,
    title: a.title,
    duration: a.duration,
    aspect_ratio: a.aspectRatio,
    protection: a.protection,
    hls: `${base}/${r.playbackId}.m3u8${tq}`,
    dash: a.hasDash ? `${base}/${r.playbackId}.mpd${tq}` : null,
    poster: `${base}/${r.playbackId}/thumbnail.jpg${tq}`,
    storyboard: a.hasStoryboard ? `${base}/${r.playbackId}/storyboard.vtt${tq}` : null,
    chapters: a.ai?.chapters?.length ? `${base}/${r.playbackId}/chapters.vtt${tq}` : null,
    drm,
  };
}
