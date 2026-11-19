import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { sessionEnvironment, canSeeSecrets, rateLimit } from "./auth.js";

const ctx = (auth: unknown) => ({ get: (k: string) => (k === "auth" ? auth : undefined) }) as any;

test("read-only access tokens never see secrets; full keys and sessions do", () => {
  assert.equal(canSeeSecrets(ctx({ kind: "key", keyId: "k", orgId: "o", permissions: "read" })), false);
  assert.equal(canSeeSecrets(ctx({ kind: "key", keyId: "k", orgId: "o", permissions: "full" })), true);
  assert.equal(canSeeSecrets(ctx({ kind: "session", userId: "u", orgId: "o", role: "member" })), true);
  assert.equal(canSeeSecrets(ctx(undefined)), false);
});

test("session requests take the environment from the header for every method", () => {
  for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) assert.equal(sessionEnvironment(m, "env_h", "env_q"), "env_h");
});

test("?environment= is only honoured for safe methods (no CSRF via simple requests)", () => {
  assert.equal(sessionEnvironment("GET", undefined, "env_q"), "env_q");
  assert.equal(sessionEnvironment("HEAD", undefined, "env_q"), "env_q");
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(sessionEnvironment(m, undefined, "env_q"), undefined, m);
});

test("rate limit: 429 with Retry-After until the window resets; other keys and the next window are unaffected", async () => {
  const counters = new Map<string, number>();
  const ttls = new Map<string, number>();
  const store = () => {
    const ops: (() => [null, unknown])[] = [];
    const m = {
      incr(k: string) {
        ops.push(() => [null, counters.set(k, (counters.get(k) ?? 0) + 1).get(k)]);
        return m;
      },
      expire(k: string, s: number) {
        ops.push(() => [null, ttls.set(k, s).size]);
        return m;
      },
      async exec() {
        return ops.map((op) => op());
      },
    };
    return { multi: () => m };
  };
  let now = Date.UTC(2026, 0, 1, 12, 0, 15, 500); // 15.5 s into a window
  const app = new Hono<any>();
  app.onError((err: any, c) => c.json({ error: err.type }, err.status ?? 500));
  app.use("*", async (c, next) => {
    c.set("auth", { kind: "key", keyId: c.req.header("x-key"), orgId: "o", permissions: "full" });
    await next();
  });
  app.use("*", rateLimit(3, { store, now: () => now }));
  app.get("/", (c) => c.text("ok"));
  const get = (key: string) => app.request("/", { headers: { "x-key": key } });

  for (let i = 0; i < 3; i++) assert.equal((await get("a")).status, 200);
  const limited = await get("a");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "45");
  assert.equal(limited.headers.get("x-ratelimit-remaining"), "0");
  assert.equal(limited.headers.get("x-ratelimit-reset"), String(Date.UTC(2026, 0, 1, 12, 1, 0) / 1000));
  // Every counter gets a TTL in the same transaction, so none can be left without one.
  assert.ok([...counters.keys()].every((k) => ttls.get(k) === 70));
  assert.equal((await get("b")).status, 200, "other credentials have their own budget");
  now += 45_000;
  const next = await get("a");
  assert.equal(next.status, 200, "the next window starts fresh");
  assert.equal(next.headers.get("x-ratelimit-remaining"), "2");
  assert.equal(next.headers.get("retry-after"), null);
});
