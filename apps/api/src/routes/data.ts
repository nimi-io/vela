import { Hono } from "hono";
import { getDb, views, assets, sql, eq, and, desc, gte, inArray } from "@vela/db";
import { ok, pagination, ApiError } from "../lib/http.js";
import type { AppEnv } from "../types.js";

const TIMEFRAMES: Record<string, { ms: number; bucket: "hour" | "day" }> = {
  "24h": { ms: 86400_000, bucket: "hour" },
  "7d": { ms: 7 * 86400_000, bucket: "day" },
  "30d": { ms: 30 * 86400_000, bucket: "day" },
  "90d": { ms: 90 * 86400_000, bucket: "day" },
};

const DIMENSIONS = {
  browser: views.browser,
  os: views.os,
  device_type: views.deviceType,
  country: views.country,
  asset_id: views.assetId,
  player_name: views.playerName,
} as const;

function scope(c: any) {
  const tf = TIMEFRAMES[c.req.query("timeframe") ?? "7d"] ?? TIMEFRAMES["7d"]!;
  const since = new Date(Date.now() - tf.ms);
  const conds = [eq(views.environmentId, c.get("environmentId")), gte(views.startedAt, since)];
  const assetId = c.req.query("asset_id");
  if (assetId) conds.push(eq(views.assetId, assetId));
  const live = c.req.query("live_stream_id");
  if (live) conds.push(eq(views.liveStreamId, live));
  return { where: and(...conds), tf, since };
}

// Per-view experience score: failed views score 0; otherwise 40% startup, 60% smoothness.
const scoreSql = sql<number>`coalesce(avg(
  case when ${views.errorCode} is not null then 0 else
    0.4 * greatest(0, least(1, 1 - (coalesce(${views.startupMs}, 0) - 500) / 7500.0)) +
    0.6 * greatest(0, least(1, 1 - 10.0 * ${views.rebufferMs}::float / nullif(${views.watchTimeMs} + ${views.rebufferMs}, 0)))
  end), 1) * 100`;

const metrics = {
  views: sql<number>`count(*)::int`,
  unique_viewers: sql<number>`count(distinct ${views.viewerId})::int`,
  watch_time_seconds: sql<number>`coalesce(sum(${views.watchTimeMs}), 0)::float / 1000`,
  avg_startup_ms: sql<number>`coalesce(avg(${views.startupMs}), 0)::int`,
  rebuffer_percentage: sql<number>`coalesce(100.0 * sum(${views.rebufferMs}) / nullif(sum(${views.watchTimeMs} + ${views.rebufferMs}), 0), 0)::float`,
  failure_percentage: sql<number>`coalesce(100.0 * count(${views.errorCode}) / nullif(count(*), 0), 0)::float`,
  experience_score: scoreSql,
};

export const dataRoutes = new Hono<AppEnv>()
  .get("/overview", async (c) => {
    const { where } = scope(c);
    const [row] = await getDb().select(metrics).from(views).where(where);
    return ok(c, row);
  })

  .get("/timeseries", async (c) => {
    const { where, tf } = scope(c);
    // tf.bucket is from a fixed whitelist ("hour" | "day"), so inlining it is safe.
    const bucket = sql<string>`date_trunc(${sql.raw(`'${tf.bucket}'`)}, ${views.startedAt})`;
    const rows = await getDb()
      .select({ time: bucket, ...metrics })
      .from(views)
      .where(where)
      .groupBy(bucket)
      .orderBy(bucket);
    return ok(c, { bucket: tf.bucket, points: rows });
  })

  .get("/breakdown", async (c) => {
    const dim = c.req.query("dimension") ?? "browser";
    const col = DIMENSIONS[dim as keyof typeof DIMENSIONS];
    if (!col) throw new ApiError(400, "invalid_parameters", `dimension must be one of ${Object.keys(DIMENSIONS).join(", ")}`);
    const { where } = scope(c);
    const rows = await getDb()
      .select({ value: col, ...metrics })
      .from(views)
      .where(where)
      .groupBy(col)
      .orderBy(desc(sql`count(*)`))
      .limit(Math.min(Number(c.req.query("limit") ?? 20), 100));
    let titles: Record<string, string | null> = {};
    if (dim === "asset_id") {
      const ids = rows.map((r) => r.value).filter(Boolean) as string[];
      if (ids.length) {
        const a = await getDb().select({ id: assets.id, title: assets.title }).from(assets).where(inArray(assets.id, ids));
        titles = Object.fromEntries(a.map((x) => [x.id, x.title]));
      }
    }
    return ok(
      c,
      rows.map((r) => ({ ...r, value: r.value ?? "unknown", label: dim === "asset_id" ? (titles[r.value ?? ""] ?? r.value) : r.value })),
    );
  })

  .get("/realtime", async (c) => {
    const since = new Date(Date.now() - 30_000);
    const db = getDb();
    const where = and(eq(views.environmentId, c.get("environmentId")), gte(views.lastSeenAt, since), eq(views.exited, false));
    const [row] = await db.select({ concurrent_viewers: sql<number>`count(*)::int` }).from(views).where(where);
    const top = await db
      .select({ asset_id: views.assetId, live_stream_id: views.liveStreamId, title: views.videoTitle, viewers: sql<number>`count(*)::int` })
      .from(views)
      .where(where)
      .groupBy(views.assetId, views.liveStreamId, views.videoTitle)
      .orderBy(desc(sql`count(*)`))
      .limit(10);
    return ok(c, { ...row, top });
  })

  .get("/views", async (c) => {
    const { where } = scope(c);
    const { limit, offset, page } = pagination(c);
    const rows = await getDb().select().from(views).where(where).orderBy(desc(views.startedAt)).limit(limit).offset(offset);
    return c.json({ data: rows, pagination: { page, limit } });
  });
