import { getDb, views, sql } from "@vela/db";
import { z } from "zod";
import { resolvePlayback } from "./playback.js";

const event = z.object({
  view_id: z.string().min(8).max(64),
  playback_id: z.string().min(8).max(64),
  event: z.string().max(32).optional(),
  viewer_id: z.string().max(128).optional(),
  watch_time_ms: z.number().int().min(0).max(1e9).optional(),
  startup_ms: z.number().int().min(0).max(600_000).optional(),
  rebuffer_count: z.number().int().min(0).max(1e6).optional(),
  rebuffer_ms: z.number().int().min(0).max(1e9).optional(),
  seek_count: z.number().int().min(0).max(1e6).optional(),
  height: z.number().int().min(0).max(10000).optional(),
  error_code: z.string().max(64).optional(),
  error_message: z.string().max(500).optional(),
  player_name: z.string().max(64).optional(),
  video_title: z.string().max(512).optional(),
  page_url: z.string().max(1000).optional(),
  exited: z.boolean().optional(),
});

export const beaconSchema = z.union([z.object({ events: z.array(event).max(50) }), event]);

export function parseUserAgent(ua: string) {
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /SamsungBrowser/.test(ua)
        ? "Samsung Internet"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : /Chrome\//.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua)
              ? "Safari"
              : /AppleCoreMedia|stagefright|ExoPlayer/.test(ua)
                ? "Native player"
                : "Other";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /iPhone|iPad|iPod/.test(ua)
      ? "iOS"
      : /Mac OS X|Macintosh/.test(ua)
        ? "macOS"
        : /Android/.test(ua)
          ? "Android"
          : /CrOS/.test(ua)
            ? "ChromeOS"
            : /Linux/.test(ua)
              ? "Linux"
              : /Tizen|Web0S|SMART-TV|AppleTV|Roku/.test(ua)
                ? "TV"
                : "Other";
  const deviceType = /SMART-TV|Tizen|Web0S|AppleTV|Roku|CrKey/.test(ua)
    ? "tv"
    : /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))
      ? "tablet"
      : /Mobi|iPhone|Android/.test(ua)
        ? "phone"
        : "desktop";
  return { browser, os, deviceType };
}

export async function recordBeacon(input: z.infer<typeof event>, ctx: { ua: string; country?: string }) {
  let r;
  try {
    r = await resolvePlayback(input.playback_id);
  } catch {
    return;
  }
  const ua = parseUserAgent(ctx.ua);
  const now = new Date();
  await getDb()
    .insert(views)
    .values({
      id: input.view_id,
      environmentId: r.environmentId,
      playbackId: input.playback_id,
      assetId: r.asset?.id ?? r.live?.activeAssetId ?? null,
      liveStreamId: r.live?.id ?? r.asset?.liveStreamId ?? null,
      viewerId: input.viewer_id,
      startedAt: now,
      lastSeenAt: now,
      watchTimeMs: input.watch_time_ms ?? 0,
      startupMs: input.startup_ms,
      rebufferCount: input.rebuffer_count ?? 0,
      rebufferMs: input.rebuffer_ms ?? 0,
      seekCount: input.seek_count ?? 0,
      maxHeight: input.height,
      errorCode: input.error_code,
      errorMessage: input.error_message,
      exited: input.exited ?? input.event === "viewend",
      browser: ua.browser,
      os: ua.os,
      deviceType: ua.deviceType,
      country: ctx.country,
      playerName: input.player_name,
      videoTitle: input.video_title ?? r.asset?.title ?? r.live?.title ?? null,
      pageUrl: input.page_url,
    })
    .onConflictDoUpdate({
      target: views.id,
      set: {
        lastSeenAt: now,
        watchTimeMs: sql`greatest(${views.watchTimeMs}, excluded.watch_time_ms)`,
        startupMs: sql`coalesce(${views.startupMs}, excluded.startup_ms)`,
        rebufferCount: sql`greatest(${views.rebufferCount}, excluded.rebuffer_count)`,
        rebufferMs: sql`greatest(${views.rebufferMs}, excluded.rebuffer_ms)`,
        seekCount: sql`greatest(${views.seekCount}, excluded.seek_count)`,
        maxHeight: sql`greatest(${views.maxHeight}, excluded.max_height)`,
        errorCode: sql`coalesce(excluded.error_code, ${views.errorCode})`,
        errorMessage: sql`coalesce(excluded.error_message, ${views.errorMessage})`,
        exited: sql`${views.exited} or excluded.exited`,
      },
    });
}
