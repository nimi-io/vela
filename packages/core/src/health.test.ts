import { test } from "node:test";
import assert from "node:assert/strict";
import { checkHealth } from "./health.js";

test("health: all checks answering is ok", async () => {
  assert.deepEqual(await checkHealth({ database: async () => 1, redis: async () => "PONG" }), { ok: true, failures: {} });
});

test("health: a check that never settles (ioredis queueing during an outage) fails at the deadline", async () => {
  const t = Date.now();
  const h = await checkHealth({ database: async () => 1, redis: () => new Promise(() => {}) }, 200);
  assert.ok(Date.now() - t < 1000, "answered promptly");
  assert.equal(h.ok, false);
  assert.deepEqual(Object.keys(h.failures), ["redis"]);
  assert.match(h.failures.redis!, /no answer within 200 ms/);
});

test("health: a failing check is reported with its error", async () => {
  const h = await checkHealth({ database: async () => Promise.reject(new Error("connect ECONNREFUSED")), redis: async () => "PONG" });
  assert.equal(h.ok, false);
  assert.deepEqual(h.failures, { database: "connect ECONNREFUSED" });
});
