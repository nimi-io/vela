import { test } from "node:test";
import assert from "node:assert/strict";
import { assertMp4SupportAllowed, isDrmSettings, ApiError } from "./assets-service.js";

test("DRM settings are detected from playback policies or protection", () => {
  assert.equal(isDrmSettings({ playback_policies: ["drm"] }), true);
  assert.equal(isDrmSettings({ playback_policy: "drm" }), true);
  assert.equal(isDrmSettings({ protection: "drm" }), true);
  assert.equal(isDrmSettings({ playback_policies: ["public", "signed"] }), false);
});

test("mp4_support is rejected for DRM assets", () => {
  for (const s of [
    { playback_policies: ["drm" as const], mp4_support: "capped-1080p" as const },
    { playback_policy: "drm" as const, mp4_support: "standard" as const },
    { protection: "drm" as const, mp4_support: "audio-only" as const },
  ]) {
    assert.throws(() => assertMp4SupportAllowed(s), (e: unknown) => e instanceof ApiError && e.status === 400);
  }
});

test("mp4_support none/omitted is fine for DRM, and any value for non-DRM", () => {
  assert.doesNotThrow(() => assertMp4SupportAllowed({ playback_policies: ["drm"], mp4_support: "none" }));
  assert.doesNotThrow(() => assertMp4SupportAllowed({ playback_policies: ["drm"] }));
  assert.doesNotThrow(() => assertMp4SupportAllowed({ playback_policies: ["signed"], mp4_support: "standard" }));
});
