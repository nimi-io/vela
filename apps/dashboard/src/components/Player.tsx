import { createElement, forwardRef, useEffect, useState } from "react";
import { useSession } from "../lib/session";

let loading: Promise<void> | null = null;

function loadPlayer(streamUrl: string) {
  if (customElements.get("vela-player")) return Promise.resolve();
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `${streamUrl.replace(/\/$/, "")}/player.js`;
      s.onload = () => resolve();
      s.onerror = () => {
        loading = null;
        reject(new Error("player script failed to load"));
      };
      document.head.appendChild(s);
    });
  }
  return loading;
}

type Props = { playbackId: string; token?: string | null; autoplay?: boolean; muted?: boolean };

/** Wraps the <vela-player> web component served by the stream service. */
export const Player = forwardRef<HTMLElement, Props>(function Player({ playbackId, token, autoplay, muted }, ref) {
  const { config } = useSession();
  const [ready, setReady] = useState(!!customElements.get("vela-player"));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!config) return;
    loadPlayer(config.stream_url).then(
      () => setReady(true),
      () => setError("The player couldn't load. Is the stream service running and STREAM_PUBLIC_URL correct?"),
    );
  }, [config]);

  if (error) return <div className="player-frame center" style={{ color: "#fff", padding: 20, textAlign: "center" }}>{error}</div>;
  if (!ready || !config) return <div className="player-frame" />;
  const attrs: Record<string, unknown> = {
    ref,
    "playback-id": playbackId,
    "stream-url": config.stream_url,
    "no-analytics": "",
    "player-name": "vela-dashboard",
  };
  if (token) {
    attrs.token = token;
    attrs["drm-token"] = token;
  }
  if (autoplay) attrs.autoplay = "";
  if (muted) attrs.muted = "";
  return <div className="player-frame">{createElement("vela-player", attrs)}</div>;
});
