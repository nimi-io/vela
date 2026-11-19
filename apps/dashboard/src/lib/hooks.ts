import { useQuery } from "@tanstack/react-query";
import { api, get } from "./api";
import { useSession } from "./session";

export type Asset = {
  id: string;
  status: "preparing" | "ready" | "errored";
  title: string | null;
  created_at: string;
  ready_at: string | null;
  duration: number | null;
  aspect_ratio: string | null;
  max_width: number | null;
  max_height: number | null;
  max_frame_rate: number | null;
  resolution_tier: string | null;
  max_resolution_tier: string;
  video_quality: string;
  mp4_support: string;
  normalize_audio: boolean;
  protection: "none" | "aes-128" | "drm";
  passthrough: string | null;
  upload_id: string | null;
  live_stream_id: string | null;
  is_live: boolean;
  test: boolean;
  renditions: { name: string; width: number; height: number; bitrate: number }[];
  static_renditions: { status: string; files: { name: string; status: string; filesize?: number; width?: number; height?: number }[] } | null;
  playback_ids: { id: string; policy: "public" | "signed" | "drm" }[];
  tracks: { id: string; type: string; status: string; name?: string; language_code?: string; text_source?: string; closed_captions?: boolean }[];
  storyboard: boolean;
  errors: { type: string; messages: string[] } | null;
  progress: { state: string; progress: number } | null;
  ai: { summary?: string; tags?: string[]; chapters?: { start_time: number; title: string }[] } | null;
  urls: { hls: string; dash: string | null; thumbnail: string; embed: string } | null;
};

export type LiveStream = {
  id: string;
  title: string | null;
  status: "idle" | "active" | "disabled";
  connected: boolean;
  stream_key: string;
  latency_mode: string;
  reconnect_window: number;
  recording: boolean;
  active_asset_id: string | null;
  recent_asset_ids: string[];
  passthrough: string | null;
  playback_ids: { id: string; policy: "public" | "signed" }[];
  simulcast_targets: { id: string; url: string; stream_key: string | null; status: string }[];
  ingest: { rtmp: { url: string; stream_key: string }; rtmps: { url: string; stream_key: string } | null; srt: { url: string } };
  created_at: string;
  last_active_at: string | null;
};

export function useEnvKey() {
  return useSession().env?.id ?? "none";
}

export function useList<T>(key: string, path: string, opts: { refetch?: (data: T[] | undefined) => number | false } = {}) {
  const envKey = useEnvKey();
  return useQuery({
    queryKey: [key, envKey, path],
    queryFn: () => api<{ data: T[]; pagination?: { page: number; limit: number; total?: number } }>(path),
    refetchInterval: (q) => (opts.refetch ? opts.refetch(q.state.data?.data) : false),
  });
}

export function useOne<T>(key: string, path: string | null, refetch?: (d: T | undefined) => number | false) {
  const envKey = useEnvKey();
  return useQuery({
    queryKey: [key, envKey, path],
    queryFn: () => get<T>(path!),
    enabled: !!path,
    refetchInterval: (q) => (refetch ? refetch(q.state.data as T | undefined) : false),
  });
}

/** Thumbnail URL for list views (public playback IDs only; others need a token). */
export function thumbUrl(streamUrl: string | undefined, a: Pick<Asset, "playback_ids" | "status">, width = 224) {
  const pid = a.playback_ids.find((p) => p.policy === "public");
  if (!streamUrl || !pid || a.status !== "ready") return null;
  return `${streamUrl}/${pid.id}/thumbnail.jpg?width=${width}`;
}
