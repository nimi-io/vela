import { test } from "node:test";
import assert from "node:assert/strict";
import { hasVideo, requireVideo, PlaybackError } from "./playback.js";

test("audio-only assets have no video: thumbnails/GIFs are a 404, not an ffmpeg 500", () => {
  const audioOnly = { maxWidth: null, maxHeight: null };
  assert.equal(hasVideo(audioOnly), false);
  assert.throws(
    () => requireVideo(audioOnly),
    (e: unknown) => e instanceof PlaybackError && e.status === 404 && /audio-only/.test(e.message),
  );
});

test("video assets pass through", () => {
  const video = { maxWidth: 1280, maxHeight: 720 };
  assert.equal(hasVideo(video), true);
  assert.equal(requireVideo(video), video);
});
