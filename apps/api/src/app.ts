import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "@hono/node-server/serve-static";
import fs from "node:fs";
import path from "node:path";
import { getDb, playbackIds, eq, and, sql } from "@vela/db";
import { env, redis, randomId, createLogger, playbackIdJson, mintPreviewToken } from "@vela/core";
import { ApiError, notFound, ok } from "./lib/http.js";
import { requireEnvironment, sessionOnly, rateLimit } from "./middleware/auth.js";
import { authRoutes } from "./routes/auth.js";
import { orgRoutes } from "./routes/org.js";
import { assetRoutes } from "./routes/assets.js";
import { uploadRoutes } from "./routes/uploads.js";
import { liveRoutes } from "./routes/live.js";
import { apiKeyRoutes, signingKeyRoutes } from "./routes/keys.js";
import { webhookRoutes, eventRoutes } from "./routes/webhooks.js";
import { drmRoutes } from "./routes/drm.js";
import { dataRoutes } from "./routes/data.js";
import { usageRoutes } from "./routes/usage.js";
import { internalRoutes } from "./routes/internal.js";
import type { AppEnv } from "./types.js";

const log = createLogger("api");

export function createApp() {
  const e = env();
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const id = c.req.header("x-request-id") ?? randomId(16);
    c.set("requestId", id);
    c.header("X-Request-Id", id);
    const start = Date.now();
    await next();
    if (!c.req.path.startsWith("/health")) {
      log.info({ method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - start, id }, "request");
    }
  });
  app.use("*", secureHeaders({ crossOriginResourcePolicy: false }));

  const origins = [e.DASHBOARD_URL, ...e.CORS_ORIGINS.split(",").map((s) => s.trim())].filter(Boolean);
  app.use(
    "/v1/*",
    cors({ origin: (o) => (origins.includes(o) ? o : null), credentials: true, allowHeaders: ["Content-Type", "Authorization", "X-Vela-Environment"] }),
  );
  app.use(
    "/auth/*",
    cors({ origin: (o) => (origins.includes(o) ? o : null), credentials: true, allowHeaders: ["Content-Type"] }),
  );

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: { type: err.type, messages: [err.message] } }, err.status as any);
    }
    log.error({ err, path: c.req.path }, "unhandled error");
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

  app.route("/auth", authRoutes);
  app.route("/internal", internalRoutes);

  const v1 = new Hono<AppEnv>();
  v1.use("*", requireEnvironment, rateLimit(Number(process.env.RATE_LIMIT_PER_MINUTE ?? 1200)));
  v1.route("/assets", assetRoutes);
  v1.route("/uploads", uploadRoutes);
  v1.route("/live-streams", liveRoutes);
  v1.route("/signing-keys", signingKeyRoutes);
  v1.route("/api-keys", apiKeyRoutes);
  v1.route("/webhooks", webhookRoutes);
  v1.route("/events", eventRoutes);
  v1.route("/drm", drmRoutes);
  v1.route("/data", dataRoutes);
  v1.route("/usage", usageRoutes);
  v1.use("/org", sessionOnly);
  v1.use("/environments/*", sessionOnly);
  v1.use("/members/*", sessionOnly);
  v1.route("/", orgRoutes);
  v1.get("/playback-ids/:id", async (c) => {
    const [p] = await getDb()
      .select()
      .from(playbackIds)
      .where(and(eq(playbackIds.id, c.req.param("id")), eq(playbackIds.environmentId, c.get("environmentId"))));
    if (!p) notFound("Playback ID");
    return ok(c, {
      ...playbackIdJson(p),
      object: p.assetId ? { type: "asset", id: p.assetId } : { type: "live_stream", id: p.liveStreamId },
    });
  });
  v1.get("/playback-ids/:id/preview-token", sessionOnly, async (c) => {
    const [p] = await getDb()
      .select()
      .from(playbackIds)
      .where(and(eq(playbackIds.id, c.req.param("id")), eq(playbackIds.environmentId, c.get("environmentId"))));
    if (!p) notFound("Playback ID");
    if (p.policy === "public") return ok(c, { token: null });
    return ok(c, { token: await mintPreviewToken(p.id), expires_in: 3600 });
  });
  app.route("/v1", v1);

  // Optionally serve the built dashboard from the API (same origin → no CORS/cookie issues).
  const dist = process.env.DASHBOARD_DIST;
  if (dist && fs.existsSync(path.join(dist, "index.html"))) {
    const indexHtml = fs.readFileSync(path.join(dist, "index.html"), "utf8");
    app.use("/assets/*", serveStatic({ root: path.relative(process.cwd(), dist) }));
    app.use("/favicon.svg", serveStatic({ root: path.relative(process.cwd(), dist) }));
    app.get("*", (c) => c.html(indexHtml));
  } else {
    app.get("/", (c) => c.json({ name: "vela-api", docs: "/docs/api.md" }));
  }

  app.notFound((c) => c.json({ error: { type: "not_found", messages: ["Route not found"] } }, 404));
  return app;
}
