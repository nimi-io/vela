import { env } from "./env.js";
import { createLogger } from "./logger.js";

const log = createLogger("core:mediamtx");

/** MediaMTX source type (as reported by its Control API) → the API collection that can kick it. */
const KICK_COLLECTIONS: Record<string, string> = {
  rtmpConn: "rtmpconns",
  rtmpsConn: "rtmpsconns",
  srtConn: "srtconns",
  rtspSession: "rtspsessions",
  rtspsSession: "rtspssessions",
  webRTCSession: "webrtcsessions",
};

function mediamtxApi(p: string, init: RequestInit = {}) {
  const e = env();
  return fetch(`${e.MEDIAMTX_API_URL}${p}`, {
    ...init,
    // MediaMTX authenticates Control API calls through the same HTTP auth hook (action "api"),
    // where the internal user is always allowed.
    headers: { Authorization: `Basic ${Buffer.from(`internal:${e.INTERNAL_SECRET}`).toString("base64")}` },
    signal: AbortSignal.timeout(5000),
  });
}

/**
 * Disconnects whoever is publishing to `live/<streamKey>`. MediaMTX only consults the auth hook
 * when a connection starts, so disabling a stream or rotating its key does not affect an encoder
 * that is already connected until it is kicked. Returns true if a publisher was disconnected.
 */
export async function kickLivePublisher(streamKey: string): Promise<boolean> {
  const res = await mediamtxApi(`/v3/paths/get/live/${encodeURIComponent(streamKey)}`);
  if (res.status === 404) return false; // nobody is publishing
  if (!res.ok) throw new Error(`MediaMTX API: GET path → ${res.status}`);
  const pathInfo = (await res.json()) as { source?: { type?: string; id?: string } | null };
  const source = pathInfo.source;
  const collection = source?.type ? KICK_COLLECTIONS[source.type] : undefined;
  if (!source?.id || !collection) {
    log.warn({ streamKey, source }, "live path has no kickable publisher");
    return false;
  }
  const kick = await mediamtxApi(`/v3/${collection}/kick/${source.id}`, { method: "POST" });
  if (kick.status === 404) return false; // disconnected in the meantime
  if (!kick.ok) throw new Error(`MediaMTX API: kick ${collection} → ${kick.status}`);
  return true;
}
