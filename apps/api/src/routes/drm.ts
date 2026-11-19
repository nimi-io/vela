import { Hono } from "hono";
import { z } from "zod";
import { getDb, drmConfigs, type DrmSettings } from "@vela/db";
import { encryptJson, env, getDrmSettings } from "@vela/core";
import { body, ok } from "../lib/http.js";
import type { AppEnv } from "../types.js";

const mask = (h?: Record<string, string>) =>
  h ? Object.fromEntries(Object.entries(h).map(([k, v]) => [k, v.length > 6 ? `${v.slice(0, 3)}…${v.slice(-2)}` : "•••"])) : undefined;

const headers = z.record(z.string(), z.string()).optional();

export const drmRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const s = await getDrmSettings(c.get("environmentId"));
    const base = `${env().STREAM_PUBLIC_URL}/license`;
    return ok(c, {
      ...s,
      license_headers: mask(s.license_headers),
      key_registration_headers: mask(s.key_registration_headers),
      // Players always talk to these; they proxy to your provider (or the built-in ClearKey server).
      player_endpoints: {
        widevine: `${base}/widevine/{PLAYBACK_ID}?token={DRM_TOKEN}`,
        playready: `${base}/playready/{PLAYBACK_ID}?token={DRM_TOKEN}`,
        fairplay: `${base}/fairplay/{PLAYBACK_ID}?token={DRM_TOKEN}`,
        fairplay_certificate: `${base}/fairplay/{PLAYBACK_ID}/cert`,
        clearkey: `${base}/clearkey/{PLAYBACK_ID}?token={DRM_TOKEN}`,
      },
    });
  })
  .put("/", async (c) => {
    const input = await body(
      c,
      z.object({
        provider: z.enum(["clearkey", "proxy"]),
        widevine_license_url: z.string().url().optional().or(z.literal("")),
        playready_license_url: z.string().url().optional().or(z.literal("")),
        fairplay_license_url: z.string().url().optional().or(z.literal("")),
        fairplay_certificate_url: z.string().url().optional().or(z.literal("")),
        license_headers: headers,
        key_registration_url: z.string().url().optional().or(z.literal("")),
        key_registration_headers: headers,
      }),
    );
    const current = await getDrmSettings(c.get("environmentId"));
    // Masked header values sent back unchanged keep their stored value.
    const keep = (incoming?: Record<string, string>, stored?: Record<string, string>) =>
      incoming
        ? Object.fromEntries(Object.entries(incoming).map(([k, v]) => [k, v.includes("…") || v === "•••" ? (stored?.[k] ?? "") : v]))
        : stored;
    const clean = (v?: string) => (v ? v : undefined);
    const settings: DrmSettings = {
      provider: input.provider,
      widevine_license_url: clean(input.widevine_license_url),
      playready_license_url: clean(input.playready_license_url),
      fairplay_license_url: clean(input.fairplay_license_url),
      fairplay_certificate_url: clean(input.fairplay_certificate_url),
      license_headers: keep(input.license_headers, current.license_headers),
      key_registration_url: clean(input.key_registration_url),
      key_registration_headers: keep(input.key_registration_headers, current.key_registration_headers),
    };
    await getDb()
      .insert(drmConfigs)
      .values({ environmentId: c.get("environmentId"), settingsEnc: encryptJson(settings) })
      .onConflictDoUpdate({ target: drmConfigs.environmentId, set: { settingsEnc: encryptJson(settings), updatedAt: new Date() } });
    return ok(c, { ...settings, license_headers: mask(settings.license_headers), key_registration_headers: mask(settings.key_registration_headers) });
  });
