import { storage, keys } from "@vela/core";

type Store = Pick<typeof storage, "deletePrefix" | "deleteKey" | "exists">;

/** Everything stored for an asset: its prefix plus a direct upload's not-yet-moved source object. */
export async function deleteAssetObjects(assetId: string, uploadId: string | null, store: Store = storage) {
  let n = await store.deletePrefix(keys.assetPrefix(assetId));
  if (uploadId && (await store.exists(keys.uploadSource(uploadId)))) {
    await store.deleteKey(keys.uploadSource(uploadId));
    n++;
  }
  return n;
}
