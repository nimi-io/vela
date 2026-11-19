import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Minimal config; nothing below touches Postgres or Redis.
process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:1/unused";
process.env.S3_BUCKET ??= "test";
process.env.S3_ACCESS_KEY_ID ??= "test";
process.env.S3_SECRET_ACCESS_KEY ??= "test";
process.env.MASTER_KEY ??= "0".repeat(64);
process.env.INTERNAL_SECRET = "test-internal-secret";

let app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

before(async () => {
  // Serve a dashboard build, like the Docker image does: its SPA catch-all must not swallow API paths.
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "vela-dash-"));
  fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>dash</title>");
  process.env.DASHBOARD_DIST = dist;
  const { createApp } = await import("./app.js");
  app = createApp();
});

test("unknown /v1, /auth and /internal routes are JSON 404s, not the dashboard's HTML", async () => {
  for (const p of ["/internal/nope", "/internal", "/auth/nope", "/auth/me/extra"]) {
    const res = await app.request(p);
    assert.equal(res.status, 404, p);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/, p);
    const body = (await res.json()) as any;
    assert.equal(body.error.type, "not_found", p);
  }
  // /v1 authenticates first; an unauthenticated request to an unknown route is a JSON 401.
  const res = await app.request("/v1/nonexistent", { method: "POST" });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
});

test("the dashboard SPA still serves its own routes", async () => {
  const res = await app.request("/videos/abc");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>dash<\/title>/);
});

test("PATCH helper drops undefined fields so an empty PATCH is a no-op instead of a 500", async () => {
  const { changes, hasChanges } = await import("./lib/http.js");
  assert.deepEqual(changes({ title: undefined, passthrough: undefined }), {});
  assert.equal(hasChanges(changes({ title: undefined })), false);
  // null is a real change (clears the field)
  assert.deepEqual(changes({ title: null, passthrough: undefined }), { title: null });
  assert.equal(hasChanges(changes({ title: null })), true);
});
