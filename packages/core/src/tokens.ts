import { SignJWT } from "jose";
import { deriveKey } from "./crypto.js";

export const PREVIEW_KID = "vela-preview";

/** Dashboard-only preview token: lets signed and DRM playback IDs play inside the dashboard. */
export async function mintPreviewToken(playbackId: string, ttlSeconds = 3600) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256", kid: PREVIEW_KID })
    .setSubject(playbackId)
    .setAudience(["v", "t", "g", "s", "d"])
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(deriveKey("preview-token"));
}
