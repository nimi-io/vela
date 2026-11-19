import type {
  assets,
  tracks,
  playbackIds,
  uploads,
  liveStreams,
  simulcastTargets,
  webhookEndpoints,
  signingKeys,
  apiKeys,
} from "@vela/db";
import { env } from "./env.js";

type Asset = typeof assets.$inferSelect;
type Track = typeof tracks.$inferSelect;
type PlaybackId = typeof playbackIds.$inferSelect;
type Upload = typeof uploads.$inferSelect;
type LiveStream = typeof liveStreams.$inferSelect;
type SimulcastTarget = typeof simulcastTargets.$inferSelect;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function playbackIdJson(p: PlaybackId) {
  return { id: p.id, policy: p.policy };
}

export function trackJson(t: Track) {
  const base: Record<string, unknown> = { id: t.id, type: t.type, status: t.status };
  if (t.type === "text") {
    Object.assign(base, {
      text_type: t.textType ?? "subtitles",
      text_source: t.textSource,
      language_code: t.languageCode,
      name: t.name,
      closed_captions: t.closedCaptions,
    });
  } else if (t.type === "audio") {
    Object.assign(base, { language_code: t.languageCode, name: t.name, ...(t.meta ?? {}) });
  } else {
    Object.assign(base, t.meta ?? {});
  }
  return base;
}

export function assetJson(a: Asset, pids: PlaybackId[] = [], trks: Track[] = []) {
  const streamUrl = env().STREAM_PUBLIC_URL;
  return {
    id: a.id,
    status: a.status,
    title: a.title,
    created_at: iso(a.createdAt),
    ready_at: iso(a.readyAt),
    duration: a.duration,
    aspect_ratio: a.aspectRatio,
    max_width: a.maxWidth,
    max_height: a.maxHeight,
    max_frame_rate: a.maxFrameRate,
    resolution_tier: a.resolutionTier,
    max_resolution_tier: a.maxResolutionTier,
    video_quality: a.videoQuality,
    mp4_support: a.mp4Support,
    normalize_audio: a.normalizeAudio,
    protection: a.protection,
    passthrough: a.passthrough,
    upload_id: a.uploadId,
    live_stream_id: a.liveStreamId,
    is_live: a.isLive,
    test: a.test,
    renditions: a.renditions,
    static_renditions: a.staticRenditions.length
      ? {
          status: a.staticRenditions.every((s) => s.status === "ready")
            ? "ready"
            : a.staticRenditions.some((s) => s.status === "errored")
              ? "errored"
              : "preparing",
          files: a.staticRenditions,
        }
      : null,
    playback_ids: pids.map(playbackIdJson),
    tracks: trks.map(trackJson),
    storyboard: a.hasStoryboard,
    errors: a.errors,
    progress: a.progress,
    ai: a.ai,
    // Convenience URLs for the first playback ID.
    urls: pids[0]
      ? {
          hls: `${streamUrl}/${pids[0].id}.m3u8`,
          dash: a.hasDash ? `${streamUrl}/${pids[0].id}.mpd` : null,
          thumbnail: `${streamUrl}/${pids[0].id}/thumbnail.jpg`,
          embed: `${streamUrl}/embed/${pids[0].id}`,
        }
      : null,
  };
}

export function uploadJson(u: Upload, url?: string) {
  return {
    id: u.id,
    status: u.status,
    url: url ?? null,
    cors_origin: u.corsOrigin,
    new_asset_settings: u.newAssetSettings,
    asset_id: u.assetId,
    timeout: u.timeoutSeconds,
    test: u.test,
    error: u.error,
    created_at: iso(u.createdAt),
    expires_at: iso(u.expiresAt),
  };
}

export function simulcastJson(s: SimulcastTarget) {
  return { id: s.id, url: s.url, stream_key: s.streamKey, passthrough: s.passthrough, status: s.status };
}

export function liveStreamJson(l: LiveStream, pids: PlaybackId[] = [], targets: SimulcastTarget[] = []) {
  const e = env();
  return {
    id: l.id,
    title: l.title,
    status: l.status,
    connected: l.connected,
    stream_key: l.streamKey,
    latency_mode: l.latencyMode,
    reconnect_window: l.reconnectWindow,
    recording: l.recording,
    new_asset_settings: l.newAssetSettings,
    active_asset_id: l.activeAssetId,
    recent_asset_ids: l.recentAssetIds,
    passthrough: l.passthrough,
    playback_ids: pids.map(playbackIdJson),
    simulcast_targets: targets.map(simulcastJson),
    health: l.health,
    ingest: {
      rtmp: { url: e.LIVE_RTMP_PUBLIC_URL, stream_key: l.streamKey },
      rtmps: e.LIVE_RTMPS_PUBLIC_URL ? { url: e.LIVE_RTMPS_PUBLIC_URL, stream_key: l.streamKey } : null,
      srt: { url: `${e.LIVE_SRT_PUBLIC_URL}?streamid=publish:live/${l.streamKey}` },
    },
    created_at: iso(l.createdAt),
    last_active_at: iso(l.lastActiveAt),
  };
}

export function webhookEndpointJson(w: typeof webhookEndpoints.$inferSelect, includeSecret = false) {
  return {
    id: w.id,
    url: w.url,
    events: w.events,
    enabled: w.enabled,
    secret: includeSecret ? w.secret : undefined,
    created_at: iso(w.createdAt),
  };
}

export function signingKeyJson(k: typeof signingKeys.$inferSelect) {
  return { id: k.id, created_at: iso(k.createdAt), revoked_at: iso(k.revokedAt) };
}

export function apiKeyJson(k: typeof apiKeys.$inferSelect) {
  return {
    id: k.id,
    name: k.name,
    permissions: k.permissions,
    last_used_at: iso(k.lastUsedAt),
    revoked_at: iso(k.revokedAt),
    created_at: iso(k.createdAt),
  };
}
