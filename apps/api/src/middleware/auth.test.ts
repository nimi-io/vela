import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionEnvironment, canSeeSecrets } from "./auth.js";

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
