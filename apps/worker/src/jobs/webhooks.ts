import type { Job } from "bullmq";
import { getDb, webhookDeliveries, webhookEvents, webhookEndpoints, eq } from "@vela/db";
import { signWebhook } from "@vela/core";

/** POSTs one event to one endpoint. Non-2xx responses throw so BullMQ retries with backoff. */
export async function deliverWebhook(job: Job<{ deliveryId: string }>) {
  const db = getDb();
  const [row] = await db
    .select({ d: webhookDeliveries, e: webhookEvents, w: webhookEndpoints })
    .from(webhookDeliveries)
    .innerJoin(webhookEvents, eq(webhookEvents.id, webhookDeliveries.eventId))
    .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
    .where(eq(webhookDeliveries.id, job.data.deliveryId));
  if (!row || row.d.status === "success") return { skipped: true };
  if (!row.w.enabled) {
    await db.update(webhookDeliveries).set({ status: "failed", responseBody: "endpoint disabled" }).where(eq(webhookDeliveries.id, row.d.id));
    return { skipped: true };
  }

  const attempts = row.d.attempts + 1;
  const payload = JSON.stringify({
    id: row.e.id,
    type: row.e.type,
    object: { type: row.e.objectType, id: row.e.objectId },
    environment: { id: row.e.environmentId },
    data: row.e.data,
    attempts,
    created_at: row.e.createdAt.toISOString(),
  });

  let status: number | null = null;
  let text = "";
  try {
    const res = await fetch(row.w.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Vela-Webhooks/1.0",
        "Vela-Signature": signWebhook(row.w.secret, payload),
        "Vela-Event-Id": row.e.id,
        "Vela-Event-Type": row.e.type,
      },
      body: payload,
      signal: AbortSignal.timeout(15_000),
      redirect: "manual",
    });
    status = res.status;
    text = (await res.text().catch(() => "")).slice(0, 2000);
  } catch (err: any) {
    text = `Request failed: ${err.message}`;
  }

  const ok = status !== null && status >= 200 && status < 300;
  const final = ok || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  await db
    .update(webhookDeliveries)
    .set({
      attempts,
      responseStatus: status,
      responseBody: text,
      lastAttemptAt: new Date(),
      status: ok ? "success" : final ? "failed" : "pending",
    })
    .where(eq(webhookDeliveries.id, row.d.id));
  if (!ok) throw new Error(`Webhook delivery failed with ${status ?? "network error"}`);
  return { status };
}
