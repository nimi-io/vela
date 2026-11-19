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
 * Environment for a cookie-authenticated request. Writes must carry the X-Vela-Environment
 * header: a custom header can't be sent cross-origin without a CORS preflight, which only
 * DASHBOARD_URL/CORS_ORIGINS pass. Accepting ?environment= for writes would let any page that
 * gets the browser to send the session cookie (a same-site sibling origin, or a browser without
 * SameSite=Lax) forge a "simple" text/plain POST, e.g. registering a webhook. Reads may use it.
 */
export function sessionEnvironment(method: string, header: string | undefined, query: string | undefined) {
  const safe = method === "GET" || method === "HEAD";
  return header ?? (safe ? query : undefined);
}

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
    const envId = sessionEnvironment(c.req.method, c.req.header("x-vela-environment"), c.req.query("environment"));
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

/**
 * Read-only access tokens are for reporting/monitoring; they must not hand out credentials that
 * allow writes elsewhere (a webhook signing secret lets the holder forge webhooks to your app).
 */
export function canSeeSecrets(c: Context) {
  const auth = c.get("auth") as AppEnv["Variables"]["auth"] | undefined;
  return !!auth && !(auth.kind === "key" && auth.permissions === "read");
}

/** Only dashboard sessions (not API keys) may manage credentials. */
export const sessionOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("auth")?.kind !== "session") {
    throw new ApiError(403, "forbidden", "This endpoint is only available from the dashboard");
  }
  await next();
};

type RateLimitMulti = { incr(key: string): RateLimitMulti; expire(key: string, seconds: number): RateLimitMulti; exec(): Promise<[Error | null, unknown][] | null> };
type RateLimitStore = { multi(): RateLimitMulti };

/**
 * Fixed one-minute window per credential, counted in Redis so every API replica shares it.
 * Responses carry X-RateLimit-Limit/-Remaining/-Reset; a 429 also carries Retry-After (seconds
 * until the window resets), so clients know when to come back instead of guessing.
 */
export function rateLimit(perMinute: number, deps: { store?: () => RateLimitStore; now?: () => number } = {}): MiddlewareHandler<AppEnv> {
  const store = deps.store ?? (redis as unknown as () => RateLimitStore);
  const now = deps.now ?? Date.now;
  return async (c, next) => {
    const auth = c.get("auth");
    const id = auth?.kind === "key" ? auth.keyId : (c.get("userId") ?? c.req.header("x-forwarded-for") ?? "anon");
    const t = now();
    const bucket = Math.floor(t / 60000);
    const k = `rl:${id}:${bucket}`;
    // One round trip, and the counter can't be left without a TTL if the process dies in between.
    const res = await store().multi().incr(k).expire(k, 70).exec();
    if (!res || res[0]?.[0]) throw res?.[0]?.[0] ?? new Error("rate limit counter failed");
    const n = Number(res[0][1]);
    const resetSec = Math.ceil(((bucket + 1) * 60000) / 1000);
    c.header("X-RateLimit-Limit", String(perMinute));
    c.header("X-RateLimit-Remaining", String(Math.max(0, perMinute - n)));
    c.header("X-RateLimit-Reset", String(resetSec));
    if (n > perMinute) {
      c.header("Retry-After", String(Math.max(1, resetSec - Math.floor(t / 1000))));
      throw new ApiError(429, "rate_limited", "Too many requests");
    }
    await next();
  };
}
