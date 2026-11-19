import crypto from "node:crypto";
import { SignJWT, importPKCS8, type KeyLike } from "jose";

export type PlaybackPolicy = "public" | "signed" | "drm";

export type AssetSettings = {
  input?: string | { url?: string; start_time?: number; end_time?: number; type?: "video" | "text"; language_code?: string; name?: string; closed_captions?: boolean; overlay_settings?: Record<string, string>; generated_subtitles?: { language_code: string; name?: string }[] }[];
  playback_policies?: PlaybackPolicy[];
  protection?: "none" | "aes-128" | "drm";
  mp4_support?: "none" | "capped-1080p" | "audio-only" | "standard";
  normalize_audio?: boolean;
  video_quality?: "basic" | "plus" | "premium";
  max_resolution_tier?: "1080p" | "1440p" | "2160p";
  passthrough?: string;
  title?: string;
  test?: boolean;
  generate_insights?: boolean;
};

export class VelaError extends Error {
  constructor(
    public status: number,
    public type: string,
    message: string,
  ) {
    super(message);
  }
}

type Opts = { tokenId?: string; tokenSecret?: string; baseUrl?: string; fetch?: typeof fetch };

/**
 * const vela = new Vela({ tokenId, tokenSecret, baseUrl: "https://api.example.com" });
 * const asset = await vela.assets.create({ input: "https://…/video.mp4", playback_policies: ["public"] });
 */
export class Vela {
  private auth: string;
  private base: string;
  private f: typeof fetch;

  constructor(opts: Opts = {}) {
    const id = opts.tokenId ?? process.env.VELA_TOKEN_ID;
    const secret = opts.tokenSecret ?? process.env.VELA_TOKEN_SECRET;
    if (!id || !secret) throw new Error("Vela: tokenId and tokenSecret are required (or VELA_TOKEN_ID / VELA_TOKEN_SECRET)");
    this.auth = `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
    this.base = (opts.baseUrl ?? process.env.VELA_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
    this.f = opts.fetch ?? fetch;
  }

  async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.f(`${this.base}${path}`, {
      method,
      headers: { Authorization: this.auth, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return undefined as T;
    const json: any = await res.json().catch(() => null);
    if (!res.ok) throw new VelaError(res.status, json?.error?.type ?? "error", json?.error?.messages?.join(" ") ?? `HTTP ${res.status}`);
    return (json?.data ?? json) as T;
  }

  private q(params?: Record<string, unknown>) {
    if (!params) return "";
    const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    const str = s.toString();
    return str ? `?${str}` : "";
  }

  assets = {
    create: (s: AssetSettings) => this.request("POST", "/v1/assets", s),
    list: (p?: { limit?: number; page?: number; status?: string; live_stream_id?: string; upload_id?: string; q?: string }) => this.request("GET", `/v1/assets${this.q(p)}`),
    retrieve: (id: string) => this.request("GET", `/v1/assets/${id}`),
    update: (id: string, p: { title?: string | null; passthrough?: string | null }) => this.request("PATCH", `/v1/assets/${id}`, p),
    delete: (id: string) => this.request("DELETE", `/v1/assets/${id}`),
    inputInfo: (id: string) => this.request("GET", `/v1/assets/${id}/input-info`),
    masterUrl: (id: string) => this.request("GET", `/v1/assets/${id}/master`),
    createPlaybackId: (id: string, policy: PlaybackPolicy = "public") => this.request("POST", `/v1/assets/${id}/playback-ids`, { policy }),
    deletePlaybackId: (id: string, pid: string) => this.request("DELETE", `/v1/assets/${id}/playback-ids/${pid}`),
    updateMp4Support: (id: string, mp4_support: AssetSettings["mp4_support"]) => this.request("PUT", `/v1/assets/${id}/mp4-support`, { mp4_support }),
    createTrack: (id: string, t: { url: string; language_code?: string; name?: string; closed_captions?: boolean }) => this.request("POST", `/v1/assets/${id}/tracks`, { type: "text", ...t }),
    deleteTrack: (id: string, tid: string) => this.request("DELETE", `/v1/assets/${id}/tracks/${tid}`),
    generateSubtitles: (id: string, language_code = "en", name?: string) => this.request("POST", `/v1/assets/${id}/generate-subtitles`, { language_code, name }),
    translateTrack: (id: string, tid: string, language_code: string, name?: string) => this.request("POST", `/v1/assets/${id}/tracks/${tid}/translate`, { language_code, name }),
    generateInsights: (id: string) => this.request("POST", `/v1/assets/${id}/insights`),
    createClip: (id: string, c: { start_time: number; end_time: number } & Omit<AssetSettings, "input">) => this.request("POST", `/v1/assets/${id}/clips`, c),
  };

  uploads = {
    create: (p: { new_asset_settings?: Omit<AssetSettings, "input">; cors_origin?: string; timeout?: number; test?: boolean } = {}) => this.request("POST", "/v1/uploads", p),
    retrieve: (id: string) => this.request("GET", `/v1/uploads/${id}`),
    list: (p?: { limit?: number; page?: number }) => this.request("GET", `/v1/uploads${this.q(p)}`),
    complete: (id: string) => this.request("POST", `/v1/uploads/${id}/complete`),
    cancel: (id: string) => this.request("PUT", `/v1/uploads/${id}/cancel`),
  };

  liveStreams = {
    create: (p: { playback_policies?: ("public" | "signed")[]; new_asset_settings?: Omit<AssetSettings, "input">; reconnect_window?: number; latency_mode?: "low" | "reduced" | "standard"; recording?: boolean; passthrough?: string; title?: string; simulcast_targets?: { url: string; stream_key?: string }[] } = {}) =>
      this.request("POST", "/v1/live-streams", p),
    list: (p?: { limit?: number; page?: number }) => this.request("GET", `/v1/live-streams${this.q(p)}`),
    retrieve: (id: string) => this.request("GET", `/v1/live-streams/${id}`),
    update: (id: string, p: Record<string, unknown>) => this.request("PATCH", `/v1/live-streams/${id}`, p),
    delete: (id: string) => this.request("DELETE", `/v1/live-streams/${id}`),
    resetStreamKey: (id: string) => this.request("POST", `/v1/live-streams/${id}/reset-stream-key`),
    disable: (id: string) => this.request("PUT", `/v1/live-streams/${id}/disable`),
    enable: (id: string) => this.request("PUT", `/v1/live-streams/${id}/enable`),
    complete: (id: string) => this.request("PUT", `/v1/live-streams/${id}/complete`),
    createPlaybackId: (id: string, policy: "public" | "signed" = "public") => this.request("POST", `/v1/live-streams/${id}/playback-ids`, { policy }),
    createSimulcastTarget: (id: string, t: { url: string; stream_key?: string; passthrough?: string }) => this.request("POST", `/v1/live-streams/${id}/simulcast-targets`, t),
    deleteSimulcastTarget: (id: string, tid: string) => this.request("DELETE", `/v1/live-streams/${id}/simulcast-targets/${tid}`),
  };

  playbackIds = { retrieve: (id: string) => this.request("GET", `/v1/playback-ids/${id}`) };

  signingKeys = {
    create: () => this.request<{ id: string; private_key: string }>("POST", "/v1/signing-keys"),
    list: () => this.request("GET", "/v1/signing-keys"),
    delete: (id: string) => this.request("DELETE", `/v1/signing-keys/${id}`),
  };

  webhooks = {
    create: (url: string, events: string[] = ["*"]) => this.request("POST", "/v1/webhooks", { url, events }),
    list: () => this.request("GET", "/v1/webhooks"),
    delete: (id: string) => this.request("DELETE", `/v1/webhooks/${id}`),
  };

  data = {
    overview: (timeframe = "7d", asset_id?: string) => this.request("GET", `/v1/data/overview${this.q({ timeframe, asset_id })}`),
    timeseries: (timeframe = "7d", asset_id?: string) => this.request("GET", `/v1/data/timeseries${this.q({ timeframe, asset_id })}`),
    breakdown: (dimension: string, timeframe = "7d") => this.request("GET", `/v1/data/breakdown${this.q({ dimension, timeframe })}`),
    realtime: () => this.request("GET", "/v1/data/realtime"),
  };
}

/* ------------------------------ Playback tokens ------------------------------ */

const keyCache = new Map<string, KeyLike>();

/**
 * Signs a playback JWT for signed/DRM playback IDs.
 * aud: "v" video (also allows thumbnails/storyboards), "t" thumbnail, "g" gif, "s" storyboard, "d" DRM license.
 */
export async function signPlaybackToken(
  playbackId: string,
  opts: {
    keyId?: string;
    /** Base64 PEM from POST /v1/signing-keys (or raw PEM). */
    privateKey?: string;
    audience?: "v" | "t" | "g" | "s" | "d";
    expiresIn?: string | number;
    claims?: { viewer_id?: string; max_resolution?: "360p" | "480p" | "720p" | "1080p" | "1440p" | "2160p"; [k: string]: unknown };
  } = {},
) {
  const kid = opts.keyId ?? process.env.VELA_SIGNING_KEY_ID;
  const raw = opts.privateKey ?? process.env.VELA_SIGNING_PRIVATE_KEY;
  if (!kid || !raw) throw new Error("signPlaybackToken: keyId and privateKey are required (or VELA_SIGNING_KEY_ID / VELA_SIGNING_PRIVATE_KEY)");
  let key = keyCache.get(kid);
  if (!key) {
    const pem = raw.includes("BEGIN") ? raw : Buffer.from(raw, "base64").toString("utf8");
    key = await importPKCS8(pem, "RS256");
    keyCache.set(kid, key);
  }
  return new SignJWT(opts.claims ?? {})
    .setProtectedHeader({ alg: "RS256", kid })
    .setSubject(playbackId)
    .setAudience(opts.audience ?? "v")
    .setExpirationTime(opts.expiresIn ?? "2h")
    .sign(key);
}

/* ------------------------------ Webhooks ------------------------------ */

/** Verifies the `Vela-Signature` header (t=<unix>,v1=<hex hmac>) against the raw request body. */
export function verifyWebhook(rawBody: string | Buffer, header: string | null | undefined, secret: string, toleranceSec = 300): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!t || !parts.v1 || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody.toString()}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default Vela;
