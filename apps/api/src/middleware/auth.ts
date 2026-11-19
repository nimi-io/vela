import type { MiddlewareHandler, Context } from "hono";
import { getCookie } from "hono/cookie";
import { getDb, sessions, users, memberships, environments, apiKeys, eq, and, isNull, gt } from "@vela/db";
import { sha256, safeEqual, redis } from "@vela/core";
import { ApiError } from "../lib/http.js";
import type { AppEnv } from "../types.js";

export const SESSION_COOKIE = "vela_session";

export async function sessionUser(c: Context) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const db = getDb();
  const [row] = await db
    .select({ user: users, session: sessions })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, new Date())));
  return row?.user ?? null;
}

/** Requires a logged-in dashboard user (cookie session). */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await sessionUser(c);
  if (!user) throw new ApiError(401, "unauthorized", "Not signed in");
  c.set("userId", user.id);
  await next();
};

/**
 * Authenticates /v1 requests. Two ways in:
 *  - HTTP Basic with an API access token (id:secret) → scoped to that key's environment
 *  - Dashboard session cookie + `X-Vela-Environment` header → any environment of the user's orgs
 */
export const requireEnvironment: MiddlewareHandler<AppEnv> = async (c, next) => {
  const db = getDb();
  const header = c.req.header("authorization");

  if (header?.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    const id = decoded.slice(0, idx);
    const secret = decoded.slice(idx + 1);
    const [row] = await db
      .select({ key: apiKeys, env: environments })
      .from(apiKeys)
      .innerJoin(environments, eq(environments.id, apiKeys.environmentId))
      .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)));
    if (!row || !safeEqual(row.key.secretHash, sha256(secret))) {
      throw new ApiError(401, "unauthorized", "Invalid access token");
    }
    c.set("auth", { kind: "key", keyId: row.key.id, orgId: row.env.orgId, permissions: row.key.permissions });
    c.set("environmentId", row.env.id);
    // Track usage without a write on every request.
    const r = redis();
    if (await r.set(`apikey:touch:${id}`, "1", "EX", 300, "NX")) {
      db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id)).catch(() => {});
    }
  } else {
    const user = await sessionUser(c);
    if (!user) throw new ApiError(401, "unauthorized", "Provide an access token or sign in");
    const envId = c.req.header("x-vela-environment") ?? c.req.query("environment");
    if (!envId) throw new ApiError(400, "missing_environment", "X-Vela-Environment header is required");
    const [row] = await db
      .select({ env: environments, m: memberships })
      .from(environments)
      .innerJoin(memberships, eq(memberships.orgId, environments.orgId))
      .where(and(eq(environments.id, envId), eq(memberships.userId, user.id), eq(memberships.status, "active")));
    if (!row) throw new ApiError(403, "forbidden", "No access to this environment");
    c.set("auth", { kind: "session", userId: user.id, orgId: row.env.orgId, role: row.m.role });
    c.set("userId", user.id);
    c.set("environmentId", row.env.id);
  }

  const method = c.req.method;
  const auth = c.get("auth");
  if (method !== "GET" && method !== "HEAD" && auth.kind === "key" && auth.permissions === "read") {
    throw new ApiError(403, "forbidden", "This access token is read-only");
  }
  await next();
};

/** Only dashboard sessions (not API keys) may manage credentials. */
export const sessionOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("auth")?.kind !== "session") {
    throw new ApiError(403, "forbidden", "This endpoint is only available from the dashboard");
  }
  await next();
};

/** Simple fixed-window rate limit per credential. */
export function rateLimit(perMinute: number): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get("auth");
    const id = auth?.kind === "key" ? auth.keyId : (c.get("userId") ?? c.req.header("x-forwarded-for") ?? "anon");
    const bucket = Math.floor(Date.now() / 60000);
    const k = `rl:${id}:${bucket}`;
    const r = redis();
    const n = await r.incr(k);
    if (n === 1) await r.expire(k, 70);
    c.header("X-RateLimit-Limit", String(perMinute));
    c.header("X-RateLimit-Remaining", String(Math.max(0, perMinute - n)));
    if (n > perMinute) throw new ApiError(429, "rate_limited", "Too many requests");
    await next();
  };
}
