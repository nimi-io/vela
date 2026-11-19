import { getDrmSettings, getContentKey, hexToB64url, b64urlToHex } from "@vela/core";
import { TtlCache } from "./cache.js";
import { PlaybackError, type Resolved, type TokenClaims } from "./playback.js";

export type DrmSystem = "widevine" | "playready" | "fairplay" | "clearkey";

const certCache = new TtlCache<Buffer>(3600_000);

function fill(template: string, vars: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

/**
 * Handles a license request after the viewer's token was verified.
 *  - clearkey: answered locally (W3C ClearKey JSON). Browser-only, for development/testing.
 *  - widevine/playready/fairplay: proxied to the configured multi-DRM provider.
 */
export async function license(
  system: DrmSystem,
  r: Resolved,
  claims: TokenClaims | null,
  body: ArrayBuffer,
  contentType: string | undefined,
): Promise<{ body: Buffer | string; type: string }> {
  const asset = r.asset;
  if (!asset || asset.protection !== "drm") throw new PlaybackError(400, "This playback ID is not DRM protected");
  const key = await getContentKey(asset.id);
  if (!key) throw new PlaybackError(404, "No content key for this asset");
  const settings = await getDrmSettings(r.environmentId);

  if (system === "clearkey") {
    if (settings.provider !== "clearkey") throw new PlaybackError(403, "ClearKey is disabled for this environment");
    let req: { kids?: string[] } = {};
    try {
      req = JSON.parse(Buffer.from(body).toString("utf8"));
    } catch {
      throw new PlaybackError(400, "Invalid ClearKey request");
    }
    const kids = (req.kids ?? []).map(b64urlToHex);
    if (kids.length && !kids.includes(key.keyId)) throw new PlaybackError(403, "Requested key is not part of this asset");
    return {
      type: "application/json",
      body: JSON.stringify({ keys: [{ kty: "oct", kid: hexToB64url(key.keyId), k: hexToB64url(key.key) }], type: "temporary" }),
    };
  }

  if (settings.provider !== "proxy") {
    throw new PlaybackError(501, `${system} requires a DRM provider. Configure one under Settings → DRM (provider: proxy).`);
  }
  const target = {
    widevine: settings.widevine_license_url,
    playready: settings.playready_license_url,
    fairplay: settings.fairplay_license_url,
  }[system];
  if (!target) throw new PlaybackError(501, `No ${system} license URL configured`);

  const vars = {
    asset_id: asset.id,
    playback_id: r.playbackId,
    key_id: key.keyId,
    key_id_uuid: `${key.keyId.slice(0, 8)}-${key.keyId.slice(8, 12)}-${key.keyId.slice(12, 16)}-${key.keyId.slice(16, 20)}-${key.keyId.slice(20)}`,
    viewer_id: String(claims?.viewer_id ?? ""),
    environment_id: r.environmentId,
  };
  const headers: Record<string, string> = { "Content-Type": contentType ?? "application/octet-stream" };
  for (const [k, v] of Object.entries(settings.license_headers ?? {})) headers[k] = fill(v, vars);

  const res = await fetch(fill(target, vars), { method: "POST", headers, body: new Uint8Array(body), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new PlaybackError(502, `License server responded ${res.status}`);
  return { body: Buffer.from(await res.arrayBuffer()), type: res.headers.get("content-type") ?? "application/octet-stream" };
}

export async function fairplayCertificate(r: Resolved) {
  const settings = await getDrmSettings(r.environmentId);
  if (!settings.fairplay_certificate_url) throw new PlaybackError(501, "No FairPlay certificate URL configured");
  return certCache.getOr(settings.fairplay_certificate_url, async () => {
    const res = await fetch(settings.fairplay_certificate_url!, { headers: settings.license_headers ?? {} });
    if (!res.ok) throw new PlaybackError(502, `Certificate fetch failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  });
}
