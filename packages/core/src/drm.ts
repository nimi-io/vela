import { getDb, drmConfigs, drmKeys, eq, type DrmSettings } from "@vela/db";
import crypto from "node:crypto";
import { decryptJson, encrypt, decrypt } from "./crypto.js";

export async function getDrmSettings(environmentId: string): Promise<DrmSettings> {
  const [row] = await getDb().select().from(drmConfigs).where(eq(drmConfigs.environmentId, environmentId));
  return row ? decryptJson<DrmSettings>(row.settingsEnc) : { provider: "clearkey" };
}

export type ContentKey = { keyId: string; key: string; iv: string }; // hex strings

/** Returns the asset's content key, creating (and persisting, encrypted) one if needed. */
export async function getOrCreateContentKey(assetId: string): Promise<{ key: ContentKey; created: boolean }> {
  const db = getDb();
  const [row] = await db.select().from(drmKeys).where(eq(drmKeys.assetId, assetId));
  if (row) {
    return { key: { keyId: row.keyId, key: decrypt(row.keyEnc).toString("hex"), iv: row.ivHex }, created: false };
  }
  const key: ContentKey = {
    keyId: crypto.randomBytes(16).toString("hex"),
    key: crypto.randomBytes(16).toString("hex"),
    iv: crypto.randomBytes(16).toString("hex"),
  };
  await db
    .insert(drmKeys)
    .values({ assetId, keyId: key.keyId, keyEnc: encrypt(Buffer.from(key.key, "hex")), ivHex: key.iv })
    .onConflictDoNothing();
  // Re-read in case another worker raced us.
  return { key: (await getOrCreateContentKey(assetId)).key, created: true };
}

export async function getContentKey(assetId: string): Promise<ContentKey | null> {
  const [row] = await getDb().select().from(drmKeys).where(eq(drmKeys.assetId, assetId));
  return row ? { keyId: row.keyId, key: decrypt(row.keyEnc).toString("hex"), iv: row.ivHex } : null;
}

export const hexToB64url = (hex: string) => Buffer.from(hex, "hex").toString("base64url");
export const b64urlToHex = (b: string) => Buffer.from(b, "base64url").toString("hex");
