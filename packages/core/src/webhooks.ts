import { getDb, webhookEndpoints, webhookEvents, webhookDeliveries, eq, and } from "@vela/db";
import { randomId, hmacHex } from "./crypto.js";
import { enqueue } from "./queues.js";

export const WEBHOOK_EVENT_TYPES = [
  "video.asset.created",
  "video.asset.ready",
  "video.asset.errored",
  "video.asset.updated",
  "video.asset.deleted",
  "video.asset.static_renditions.ready",
  "video.asset.track.created",
  "video.asset.track.ready",
  "video.asset.track.errored",
  "video.asset.live_stream_completed",
  "video.upload.created",
  "video.upload.asset_created",
  "video.upload.cancelled",
  "video.upload.errored",
  "video.live_stream.created",
  "video.live_stream.connected",
  "video.live_stream.active",
  "video.live_stream.disconnected",
  "video.live_stream.idle",
  "video.live_stream.deleted",
  "video.live_stream.simulcast_target.broadcasting",
  "video.live_stream.simulcast_target.errored",
] as const;

/**
 * Records an event and queues delivery to every matching enabled endpoint in the environment.
 * Never throws: webhook problems must not break the main flow.
 */
export async function emitEvent(
  environmentId: string,
  type: string,
  data: Record<string, unknown>,
  object?: { type: string; id: string },
) {
  try {
    const db = getDb();
    const id = randomId(24);
    await db.insert(webhookEvents).values({
      id,
      environmentId,
      type,
      data,
      objectType: object?.type,
      objectId: object?.id,
    });
    const endpoints = await db
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.environmentId, environmentId), eq(webhookEndpoints.enabled, true)));
    for (const ep of endpoints) {
      if (!ep.events.includes("*") && !ep.events.includes(type)) continue;
      const deliveryId = randomId(24);
      await db.insert(webhookDeliveries).values({ id: deliveryId, eventId: id, endpointId: ep.id });
      await enqueue(
        "webhook.deliver",
        { deliveryId },
        { attempts: 10, backoff: { type: "exponential", delay: 10_000 } },
      );
    }
  } catch (err) {
    console.error("emitEvent failed", type, err);
  }
}

/** Header value: t=<unix>,v1=<hex hmac of `${t}.${body}`> — same scheme as Mux/Stripe. */
export function signWebhook(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${hmacHex(secret, `${timestamp}.${body}`)}`;
}

export function verifyWebhookSignature(secret: string, body: string, header: string, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  return hmacHex(secret, `${t}.${body}`) === parts.v1;
}
