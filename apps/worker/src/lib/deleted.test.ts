import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanUpIfDeleted, deleteAssetObjects } from "./deleted.js";

function fakeStore(objects: string[]) {
  const set = new Set(objects);
  return {
    set,
    async deletePrefix(prefix: string) {
      const hit = [...set].filter((k) => k.startsWith(prefix));
      hit.forEach((k) => set.delete(k));
      return hit.length;
    },
    async deleteKey(key: string) {
      set.delete(key);
    },
    async exists(key: string) {
      return set.has(key);
    },
  };
}

const files = ["assets/A1/hls/master.m3u8", "assets/A1/source", "assets/A1/static/high.mp4", "assets/A10/source", "uploads/U1/source", "uploads/U2/source"];

test("deleteAssetObjects removes the asset prefix and the upload's pending source, nothing else", async () => {
  const store = fakeStore(files);
  const n = await deleteAssetObjects("A1", "U1", store as any);
  assert.equal(n, 4);
  assert.deepEqual([...store.set].sort(), ["assets/A10/source", "uploads/U2/source"]);
});

test("cleanUpIfDeleted: live asset → untouched", async () => {
  const store = fakeStore(files);
  const r = await cleanUpIfDeleted("A1", { state: async () => ({ deletedAt: null, uploadId: "U1" }), store: store as any });
  assert.equal(r, false);
  assert.equal(store.set.size, files.length);
});

test("cleanUpIfDeleted: asset deleted mid-job → its late writes are removed", async () => {
  const store = fakeStore(files);
  const r = await cleanUpIfDeleted("A1", { state: async () => ({ deletedAt: new Date(), uploadId: "U1" }), store: store as any });
  assert.equal(r, true);
  assert.ok(![...store.set].some((k) => k.startsWith("assets/A1/") || k === "uploads/U1/source"));
  assert.ok(store.set.has("assets/A10/source"));
});
