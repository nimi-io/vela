import { test } from "node:test";
import assert from "node:assert/strict";
import { masterSource } from "./storage.js";

test("regular assets read their own master", () => {
  assert.deepEqual(masterSource({ id: "A", sourceKey: null, input: [{ url: "https://x/y.mp4" }] }), { key: "assets/A/source", start: 0 });
});

test("clips with their own (pre-cut) master don't depend on the parent", () => {
  const clip = { id: "C", sourceKey: "assets/C/source", input: [{ url: "vela://assets/P", start_time: 5, end_time: 9 }] };
  assert.deepEqual(masterSource(clip), { key: "assets/C/source", start: 0 });
});

test("legacy clips (no own master) fall back to the parent's master + range", () => {
  const clip = { id: "C", sourceKey: null, input: [{ url: "vela://assets/P", start_time: 5, end_time: 9 }] };
  assert.deepEqual(masterSource(clip), { key: "assets/P/source", start: 5, end: 9 });
});
