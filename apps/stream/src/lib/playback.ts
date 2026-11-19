import { importSPKI, jwtVerify, decodeProtectedHeader, type KeyLike } from "jose";
import { getDb, playbackIds, assets, tracks, liveStreams, signingKeys, eq, and, isNull } from "@vela/db";
import { signStreamToken, verifyStreamToken, deriveKey, PREVIEW_KID, type Invalidation } from "@vela/core";
import { TtlCache } from "./cache.js";

export type Audience = "v" | "t" | "g" | "s" | "d";

export class PlaybackError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Resolved = {
  playbackId: string;
  policy: "public" | "signed" | "drm";
  environmentId: string;
  asset?: typeof assets.$inferSelect & { textTracks: (typeof tracks.$inferSelect)[] };
  live?: typeof liveStreams.$inferSelect;
};

const resolveCache = new TtlCache<Resolved | null>(10_000);

/** Playback ID → asset or live stream (cached for a few seconds). */
export async function resolvePlayback(playbackId: string): Promise<Resolved> {
  if (!/^[A-Za-z0-9]{8,64}$/.test(playbackId)) throw new PlaybackError(404, "Playback ID not found");
  let r = resolveCache.get(playbackId);
  if (r === undefined) r = await loadPlayback(playbackId);
  if (!r) throw new PlaybackError(404, "Playback ID not found");
  return r;
}

async function loadPlayback(playbackId: string): Promise<Resolved | null> {
  const r = await (async () => {
    const db = getDb();
    const [p] = await db.select().from(playbackIds).where(eq(playbackIds.id, playbackId));
    if (!p) return null;
    const out: Resolved = { playbackId, policy: p.policy, environmentId: p.environmentId };
    if (p.assetId) {
      const [a] = await db.select().from(assets).where(and(eq(assets.id, p.assetId), isNull(assets.deletedAt)));
      if (!a) return null;
      const t = await db.select().from(tracks).where(and(eq(tracks.assetId, a.id), eq(tracks.type, "text"), eq(tracks.status, "ready")));
      out.asset = { ...a, textTracks: t };
    } else if (p.liveStreamId) {
      const [l] = await db.select().from(liveStreams).where(eq(liveStreams.id, p.liveStreamId));
      if (!l) return null;
      out.live = l;
    }
    return out;
  })();
  // Short TTL while things are changing (processing assets, renditions being made, live streams).
  const settling =
    !r || !!r.live || r.asset?.status !== "ready" || r.asset?.staticRenditions.some((s) => s.status === "preparing") || (r.asset?.mp4Support !== "none" && !r.asset?.staticRenditions.length);
  resolveCache.set(playbackId, r, settling ? 2000 : 15_000);
  return r;
}

const keyCache = new TtlCache<KeyLike | null>(60_000);

/** Drop cached lookups the API has just made stale (published on Redis; see @vela/core invalidate). */
export function invalidate(msg: Invalidation) {
  for (const id of msg.playbackIds ?? []) resolveCache.delete(id);
  for (const k of msg.signingKeys ?? []) keyCache.delete(k);
}

async function signingKey(environmentId: string, kid: string) {
  return keyCache.getOr(`${environmentId}:${kid}`, async () => {
    const [k] = await getDb()
      .select()
      .from(signingKeys)
      .where(and(eq(signingKeys.id, kid), eq(signingKeys.environmentId, environmentId), isNull(signingKeys.revokedAt)));
    return k ? importSPKI(k.publicKey, "RS256") : null;
  });
}

export type TokenClaims = { exp: number; sub: string; aud: string; [k: string]: unknown };

/**
 * Verifies a playback JWT (RS256, signed with one of the environment's signing keys).
 * Claims: sub = playback ID, aud = v|t|g|s|d, exp required, kid header = signing key ID.
 * Optional: viewer_id, max_resolution, playback_restriction... (passed through).
 */
export async function verifyToken(r: Resolved, token: string | undefined, aud: Audience): Promise<TokenClaims | null> {
  if (r.policy === "public") return null;
  if (!token) throw new PlaybackError(403, "This playback ID requires a signed token");
  let kid: string | undefined;
  try {
    kid = decodeProtectedHeader(token).kid;
  } catch {
    throw new PlaybackError(403, "Malformed token");
  }
  if (!kid) throw new PlaybackError(403, "Token is missing the kid header");
  if (kid === PREVIEW_KID) {
    // Short-lived dashboard preview tokens minted by the API (HS256 with a key derived from MASTER_KEY).
    try {
      const { payload } = await jwtVerify(token, deriveKey("preview-token"), { algorithms: ["HS256"], subject: r.playbackId });
      return payload as TokenClaims;
    } catch (err) {
      throw new PlaybackError(403, `Invalid preview token: ${(err as Error).message}`);
    }
  }
  const key = await signingKey(r.environmentId, kid);
  if (!key) throw new PlaybackError(403, "Unknown or revoked signing key");
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["RS256"], subject: r.playbackId });
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    // A video token also grants thumbnails/storyboards; DRM license accepts v or d.
    const okAud =
      audiences.includes(aud) ||
      (aud === "d" && audiences.includes("v")) ||
      ((aud === "t" || aud === "s" || aud === "g") && audiences.includes("v"));
    if (!okAud) throw new PlaybackError(403, `Token audience must include "${aud}"`);
    if (!payload.exp) throw new PlaybackError(403, "Token must have an exp claim");
    return payload as TokenClaims;
  } catch (err) {
    if (err instanceof PlaybackError) throw err;
    throw new PlaybackError(403, `Invalid token: ${(err as Error).message}`);
  }
}

/** Path token for rendition/segment URLs once the viewer is authorised. */
export function pathToken(r: Resolved, claims: TokenClaims | null): string {
  if (r.policy === "public" || !claims) return "p";
  // Round expiry up to 5 minutes so CDNs can share cached segments between viewers.
  const exp = Math.ceil(claims.exp / 300) * 300;
  return signStreamToken(r.playbackId, exp);
}

export function checkPathToken(r: Resolved, st: string) {
  if (r.policy === "public") {
    if (st !== "p") throw new PlaybackError(403, "Bad path token");
    return;
  }
  if (!verifyStreamToken(r.playbackId, st)) throw new PlaybackError(403, "Playback session expired");
}
