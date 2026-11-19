import { test } from "node:test";
import assert from "node:assert/strict";
import { httpUrl, webhookEventList, isoDay } from "./validators.js";

test("httpUrl only accepts http(s)", () => {
  assert.equal(httpUrl.safeParse("https://example.com/hook").success, true);
  assert.equal(httpUrl.safeParse("http://example.com:8080/x?y=1").success, true);
  for (const bad of ["ftp://example.com/x", "file:///etc/passwd", "javascript:alert(1)", "gopher://x", "not a url", ""]) {
    assert.equal(httpUrl.safeParse(bad).success, false, bad);
  }
});

test("webhook events must be * or a known event type", () => {
  assert.equal(webhookEventList.safeParse(["*"]).success, true);
  assert.equal(webhookEventList.safeParse(["video.asset.ready", "video.live_stream.active"]).success, true);
  assert.equal(webhookEventList.safeParse([]).success, false);
  const r = webhookEventList.safeParse(["video.asset.ready", "video.asset.nonsense"]);
  assert.equal(r.success, false);
  assert.match(r.error!.issues[0]!.message, /video\.asset\.nonsense/);
});

test("isoDay accepts real YYYY-MM-DD dates only", () => {
  assert.equal(isoDay.safeParse("2026-11-01").success, true);
  assert.equal(isoDay.safeParse("2024-02-29").success, true);
  for (const bad of ["garbage", "2026-13-01", "2026-02-30", "2026-1-1", "2026-11-01T00:00:00Z", "'; drop table x; --"]) {
    assert.equal(isoDay.safeParse(bad).success, false, bad);
  }
});
