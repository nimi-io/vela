import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLadder } from "./ladder.js";

test("1080p source gets full ladder capped at 1080p", () => {
  const l = buildLadder({ width: 1920, height: 1080, frameRate: 30 });
  assert.equal(l[0]!.name, "1080p");
  assert.equal(l[0]!.width, 1920);
  assert.deepEqual(
    l.map((r) => r.name),
    ["1080p", "720p", "540p", "360p", "240p"],
  );
});

test("never upscales", () => {
  const l = buildLadder({ width: 640, height: 360, frameRate: 30 });
  assert.ok(l.every((r) => r.height <= 360));
});

test("portrait video keeps orientation", () => {
  const l = buildLadder({ width: 1080, height: 1920, frameRate: 30 });
  assert.equal(l[0]!.width, 1080);
  assert.equal(l[0]!.height, 1920);
});

test("4K only with 2160p tier", () => {
  assert.equal(buildLadder({ width: 3840, height: 2160, frameRate: 30 })[0]!.name, "1080p");
  assert.equal(
    buildLadder({ width: 3840, height: 2160, frameRate: 30 }, { maxResolutionTier: "2160p" })[0]!.name,
    "2160p",
  );
});

test("odd sizes get an extra top rung and even dimensions", () => {
  const l = buildLadder({ width: 1000, height: 562, frameRate: 25 });
  assert.equal(l[0]!.height % 2, 0);
  assert.equal(l[0]!.width % 2, 0);
  assert.equal(l[0]!.name, "562p");
});

test("low-bitrate source caps rendition bitrate", () => {
  const l = buildLadder({ width: 1920, height: 1080, frameRate: 30, videoBitrate: 800_000 });
  assert.ok(l[0]!.videoBitrate <= 1_000_000);
});

test("basic quality limits rungs", () => {
  assert.equal(buildLadder({ width: 1920, height: 1080, frameRate: 30 }, { videoQuality: "basic" }).length, 3);
});
