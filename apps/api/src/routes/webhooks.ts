import { Hono } from "hono";
import { z } from "zod";
import {
  getDb,
  webhookEndpoints,
  webhookDeliveries,
  webhookEvents,
  eq,
  and,
  desc,
  sql,
} from "@vela/db";
import { randomId, randomSecret, webhookEndpointJson, enqueue, emitEvent, WEBHOOK_EVENT_TYPES } from "@vela/core";
import { body, ok, notFound, pagination } from "../lib/http.js";
import type { AppEnv } from "../types.js";

async function loadEndpoint(envId: string, id: string) {
  const [w] = await getDb()
    .select()
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.environmentId, envId)));
  if (!w) notFound("Webhook");
  return w;
}

const eventsSchema = z.array(z.string()).min(1).default(["*"]);

export const webhookRoutes = new Hono<AppEnv>()
  .get("/event-types", (c) => ok(c, WEBHOOK_EVENT_TYPES))
  .get("/", async (c) => {
    const rows = await getDb()
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.environmentId, c.get("environmentId")))
      .orderBy(desc(webhookEndpoints.createdAt));
    return ok(c, rows.map((w) => webhookEndpointJson(w, true)));
  })
  .post("/", async (c) => {
    const input = await body(c, z.object({ url: z.string().url(), events: eventsSchema }));
    const [w] = await getDb()
      .insert(webhookEndpoints)
      .values({ id: randomId(24), environmentId: c.get("environmentId"), url: input.url, events: input.events, secret: randomSecret(24) })
      .returning();
    return ok(c, webhookEndpointJson(w!, true), 201);
  })
  .get("/:id", async (c) => ok(c, webhookEndpointJson(await loadEndpoint(c.get("environmentId"), c.req.param("id")), true)))
  .patch("/:id", async (c) => {
    const w = await loadEndpoint(c.get("environmentId"), c.req.param("id"));
    const input = await body(
      c,
      z.object({ url: z.string().url().optional(), events: z.array(z.string()).min(1).optional(), enabled: z.boolean().optional() }),
    );
    const [u] = await getDb().update(webhookEndpoints).set(input).where(eq(webhookEndpoints.id, w.id)).returning();
    return ok(c, webhookEndpointJson(u!, true));
  })
  .post("/:id/rotate-secret", async (c) => {
    const w = await loadEndpoint(c.get("environmentId"), c.req.param("id"));
    const [u] = await getDb()
      .update(webhookEndpoints)
      .set({ secret: randomSecret(24) })
      .where(eq(webhookEndpoints.id, w.id))
      .returning();
    return ok(c, webhookEndpointJson(u!, true));
  })
  .delete("/:id", async (c) => {
    const w = await loadEndpoint(c.get("environmentId"), c.req.param("id"));
    await getDb().delete(webhookEndpoints).where(eq(webhookEndpoints.id, w.id));
    return c.body(null, 204);
  })
  .post("/:id/test", async (c) => {
    const w = await loadEndpoint(c.get("environmentId"), c.req.param("id"));
    const db = getDb();
    const eventId = randomId(24);
    await db.insert(webhookEvents).values({
      id: eventId,
      environmentId: w.environmentId,
      type: "webhook.test",
      data: { message: "This is a test event from Vela", endpoint_id: w.id },
    });
    const deliveryId = randomId(24);
    await db.insert(webhookDeliveries).values({ id: deliveryId, eventId, endpointId: w.id });
    await enqueue("webhook.deliver", { deliveryId }, { attempts: 1 });
    return ok(c, { delivery_id: deliveryId }, 201);
  })
  .get("/:id/deliveries", async (c) => {
    const w = await loadEndpoint(c.get("environmentId"), c.req.param("id"));
    const { limit, offset, page } = pagination(c);
    const rows = await getDb()
      .select({ d: webhookDeliveries, e: webhookEvents })
      .from(webhookDeliveries)
      .innerJoin(webhookEvents, eq(webhookEvents.id, webhookDeliveries.eventId))
      .where(eq(webhookDeliveries.endpointId, w.id))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(limit)
      .offset(offset);
    return c.json({
      data: rows.map(({ d, e }) => ({
        id: d.id,
        status: d.status,
        attempts: d.attempts,
        response_status: d.responseStatus,
        response_body: d.responseBody,
        last_attempt_at: d.lastAttemptAt,
        created_at: d.createdAt,
        event: { id: e.id, type: e.type, data: e.data, created_at: e.createdAt },
      })),
      pagination: { page, limit },
    });
  })
  .post("/deliveries/:did/redeliver", async (c) => {
    const db = getDb();
    const [row] = await db
      .select({ d: webhookDeliveries, w: webhookEndpoints })
      .from(webhookDeliveries)
      .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
      .where(and(eq(webhookDeliveries.id, c.req.param("did")), eq(webhookEndpoints.environmentId, c.get("environmentId"))));
    if (!row) notFound("Delivery");
    const id = randomId(24);
    await db.insert(webhookDeliveries).values({ id, eventId: row.d.eventId, endpointId: row.d.endpointId });
    await enqueue("webhook.deliver", { deliveryId: id }, { attempts: 1 });
    return ok(c, { delivery_id: id }, 201);
  });

export const eventRoutes = new Hono<AppEnv>().get("/", async (c) => {
  const { limit, offset, page } = pagination(c);
  const db = getDb();
  const conds = [eq(webhookEvents.environmentId, c.get("environmentId"))];
  const type = c.req.query("type");
  if (type) conds.push(eq(webhookEvents.type, type));
  const objectId = c.req.query("object_id");
  if (objectId) conds.push(eq(webhookEvents.objectId, objectId));
  const rows = await db
    .select()
    .from(webhookEvents)
    .where(and(...conds))
    .orderBy(desc(webhookEvents.createdAt))
    .limit(limit)
    .offset(offset);
  const [{ total }] = (await db
    .select({ total: sql<number>`count(*)::int` })
    .from(webhookEvents)
    .where(and(...conds))) as [{ total: number }];
  return c.json({
    data: rows.map((e) => ({ id: e.id, type: e.type, object: { type: e.objectType, id: e.objectId }, data: e.data, created_at: e.createdAt })),
    pagination: { page, limit, total },
  });
});

// Re-export so index can emit a test event if needed.
export { emitEvent };
