import type { Redis } from "ioredis";
import { getDb, playbackIds, eq } from "@vela/db";
import { redis } from "./queues.js";
import { createLogger } from "./logger.js";

/**
 * Cross-replica cache invalidation. The stream service caches playback-ID lookups and signing
 * keys per process; when the API deletes a playback ID / asset / live stream or revokes a signing
 * key it publishes here so every stream replica drops the stale entry immediately. The caches'
 * TTLs stay as the fallback if a message is missed (e.g. while Redis is restarting).
 */
export const INVALIDATION_CHANNEL = "vela:invalidate";

export type Invalidation = {
  /** Playback IDs that no longer resolve (or resolve differently). */
  playbackIds?: string[];
  /** Signing keys as `${environmentId}:${keyId}`. */
  signingKeys?: string[];
};

const log = createLogger("invalidate");

export async function publishInvalidation(msg: Invalidation): Promise<void> {
  if (!msg.playbackIds?.length && !msg.signingKeys?.length) return;
  try {
    await redis().publish(INVALIDATION_CHANNEL, JSON.stringify(msg));
  } catch (err) {
    // Never fail the API request over this; replicas fall back to their cache TTL.
    log.warn({ err }, "failed to publish cache invalidation");
  }
}

/**
 * Invalidate every playback ID of an asset. Call after changing anything the stream service reads
 * from the asset row (status, renditions, static MP4s, text tracks) so viewers see it at once
 * instead of after the cache TTL.
 */
export async function invalidateAssetPlayback(assetId: string): Promise<void> {
  try {
    const rows = await getDb().select({ id: playbackIds.id }).from(playbackIds).where(eq(playbackIds.assetId, assetId));
    await publishInvalidation({ playbackIds: rows.map((r) => r.id) });
  } catch (err) {
    log.warn({ err, assetId }, "failed to invalidate asset playback");
  }
}

let subscriber: Redis | undefined;

/** Subscribe to invalidations (one dedicated connection per process; ioredis resubscribes on reconnect). */
export function onInvalidation(handler: (msg: Invalidation) => void): () => Promise<void> {
  const sub = (subscriber ??= redis().duplicate());
  sub.subscribe(INVALIDATION_CHANNEL).catch((err) => log.error({ err }, "failed to subscribe to cache invalidations"));
  const listener = (channel: string, raw: string) => {
    if (channel !== INVALIDATION_CHANNEL) return;
    try {
      handler(JSON.parse(raw) as Invalidation);
    } catch (err) {
      log.warn({ err }, "bad invalidation message");
    }
  };
  sub.on("message", listener);
  return async () => {
    sub.off("message", listener);
    if (subscriber === sub) {
      subscriber = undefined;
      await sub.quit().catch(() => {});
    }
  };
}
