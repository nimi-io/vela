import { getDb, assets, eq } from "@vela/db";
import { storage, keys } from "@vela/core";

type Store = Pick<typeof storage, "deletePrefix" | "deleteKey" | "exists">;
type AssetState = { deletedAt: Date | null; uploadId: string | null } | undefined;

async function assetState(assetId: string): Promise<AssetState> {
  const [a] = await getDb().select({ deletedAt: assets.deletedAt, uploadId: assets.uploadId }).from(assets).where(eq(assets.id, assetId));
  return a;
}

/**
 * Jobs that write under assets/<id>/ must call this after their last write. DELETE /v1/assets
 * sets deleted_at and then queues asset.delete; a job that was already running can upload files
 * after that delete job has emptied the prefix, leaving orphans nobody will ever remove.
 * Ordering makes this safe: either this check sees deleted_at (and cleans up itself), or the
 * deletion happens after our writes and the delete job removes them.
 */
export async function cleanUpIfDeleted(
  assetId: string,
  deps: { state?: (id: string) => Promise<AssetState>; store?: Store } = {},
): Promise<boolean> {
  const a = await (deps.state ?? assetState)(assetId);
  if (a && !a.deletedAt) return false;
  await deleteAssetObjects(assetId, a?.uploadId ?? null, deps.store);
  return true;
}

/** Everything stored for an asset: its prefix plus a direct upload's not-yet-moved source object. */
export async function deleteAssetObjects(assetId: string, uploadId: string | null, store: Store = storage) {
  let n = await store.deletePrefix(keys.assetPrefix(assetId));
  if (uploadId && (await store.exists(keys.uploadSource(uploadId)))) {
    await store.deleteKey(keys.uploadSource(uploadId));
    n++;
  }
  return n;
}
