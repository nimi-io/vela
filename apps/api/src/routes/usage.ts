import { Hono } from "hono";
import { getDb, usageDaily, assets, sql, eq, and, gte, lte, isNull } from "@vela/db";
import { ok } from "../lib/http.js";
import type { AppEnv } from "../types.js";

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Usage is rolled up hourly by the worker into usage_daily. Rates are optional and only
 * used to show an estimated cost in the dashboard (set via USAGE_RATE_* env vars).
 */
export const usageRoutes = new Hono<AppEnv>().get("/", async (c) => {
  const now = new Date();
  const from = c.req.query("from") ?? day(new Date(now.getFullYear(), now.getMonth(), 1));
  const to = c.req.query("to") ?? day(now);
  const db = getDb();
  const envId = c.get("environmentId");

  const rows = await db
    .select()
    .from(usageDaily)
    .where(and(eq(usageDaily.environmentId, envId), gte(usageDaily.day, from), lte(usageDaily.day, to)))
    .orderBy(usageDaily.day);

  const [stored] = await db
    .select({
      assets: sql<number>`count(*)::int`,
      seconds: sql<number>`coalesce(sum(${assets.duration}), 0)::float`,
    })
    .from(assets)
    .where(and(eq(assets.environmentId, envId), isNull(assets.deletedAt), eq(assets.status, "ready")));

  const sum = (k: "encodedSeconds" | "deliveredSeconds" | "liveSeconds") => rows.reduce((a, r) => a + r[k], 0);
  const totals = {
    encoded_minutes: sum("encodedSeconds") / 60,
    delivered_minutes: sum("deliveredSeconds") / 60,
    live_minutes: sum("liveSeconds") / 60,
    stored_minutes: (stored?.seconds ?? 0) / 60,
    stored_assets: stored?.assets ?? 0,
  };
  const rate = (name: string) => Number(process.env[name] ?? 0);
  const rates = {
    encoding_per_minute: rate("USAGE_RATE_ENCODING_PER_MIN"),
    storage_per_minute_month: rate("USAGE_RATE_STORAGE_PER_MIN_MONTH"),
    delivery_per_minute: rate("USAGE_RATE_DELIVERY_PER_MIN"),
  };
  const estimated_cost =
    totals.encoded_minutes * rates.encoding_per_minute +
    totals.stored_minutes * rates.storage_per_minute_month +
    totals.delivered_minutes * rates.delivery_per_minute;

  return ok(c, {
    from,
    to,
    totals,
    rates,
    estimated_cost,
    daily: rows.map((r) => ({
      day: r.day,
      encoded_minutes: r.encodedSeconds / 60,
      delivered_minutes: r.deliveredSeconds / 60,
      live_minutes: r.liveSeconds / 60,
      stored_minutes: r.storedSeconds / 60,
    })),
  });
});
