const rid = (n = 24) => {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => a[b % a.length]).join("");
};

function viewerId(explicit?: string | null) {
  if (explicit) return explicit;
  try {
    let v = localStorage.getItem("vela_viewer");
    if (!v) {
      v = rid(20);
      localStorage.setItem("vela_viewer", v);
    }
    return v;
  } catch {
    return rid(20);
  }
}

/**
 * Quality-of-experience tracking: watch time, startup time, rebuffering, seeks, errors.
 * Sends cumulative counters so lost beacons never corrupt totals.
 */
export class ViewMonitor {
  private viewId = rid(24);
  private viewer: string;
  private loadStart = performance.now();
  private playRequested: number | null = null;
  private startupMs: number | null = null;
  private watchMs = 0;
  private playingSince: number | null = null;
  private rebufferCount = 0;
  private rebufferMs = 0;
  private rebufferSince: number | null = null;
  private seekCount = 0;
  private seeking = false;
  private maxHeight = 0;
  private error: { code: string; message: string } | null = null;
  private started = false;
  private ended = false;
  private timer: number | undefined;
  private lastSent = "";
  private cleanup: (() => void)[] = [];

  constructor(
    private video: HTMLVideoElement,
    private opts: { endpoint: string; playbackId: string; viewerId?: string | null; title?: string | null; playerName?: string },
  ) {
    this.viewer = viewerId(opts.viewerId);
    const on = (ev: string, fn: () => void) => {
      video.addEventListener(ev, fn);
      this.cleanup.push(() => video.removeEventListener(ev, fn));
    };
    on("play", () => {
      if (this.playRequested === null) this.playRequested = performance.now();
    });
    on("playing", () => {
      const now = performance.now();
      if (this.startupMs === null) {
        this.startupMs = Math.round(now - (this.playRequested ?? this.loadStart));
        this.started = true;
        this.send("viewstart");
      }
      if (this.rebufferSince !== null) {
        this.rebufferMs += now - this.rebufferSince;
        this.rebufferSince = null;
      }
      this.playingSince = now;
      this.seeking = false;
    });
    const stopClock = () => {
      if (this.playingSince !== null) {
        this.watchMs += performance.now() - this.playingSince;
        this.playingSince = null;
      }
    };
    on("pause", () => {
      stopClock();
      this.send("pause");
    });
    on("waiting", () => {
      stopClock();
      if (this.started && !this.seeking && this.rebufferSince === null) {
        this.rebufferSince = performance.now();
        this.rebufferCount++;
      }
    });
    on("seeking", () => {
      this.seeking = true;
      if (this.started) this.seekCount++;
    });
    on("ended", () => {
      stopClock();
      this.ended = true;
      this.send("ended");
    });
    on("resize", () => {
      this.maxHeight = Math.max(this.maxHeight, video.videoHeight || 0);
    });
    const hide = () => {
      if (document.visibilityState === "hidden") this.send("viewend", true);
    };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", hide);
    this.cleanup.push(() => document.removeEventListener("visibilitychange", hide));
    this.cleanup.push(() => window.removeEventListener("pagehide", hide));
    this.timer = window.setInterval(() => this.started && this.send("heartbeat"), 10_000);
  }

  setError(code: string, message: string) {
    this.error = { code, message: message.slice(0, 480) };
    this.send("error");
  }

  private snapshot(event: string) {
    const now = performance.now();
    const watch = this.watchMs + (this.playingSince !== null ? now - this.playingSince : 0);
    const rebuf = this.rebufferMs + (this.rebufferSince !== null ? now - this.rebufferSince : 0);
    return {
      view_id: this.viewId,
      playback_id: this.opts.playbackId,
      event,
      viewer_id: this.viewer,
      watch_time_ms: Math.round(watch),
      startup_ms: this.startupMs ?? undefined,
      rebuffer_count: this.rebufferCount,
      rebuffer_ms: Math.round(rebuf),
      seek_count: this.seekCount,
      height: this.maxHeight || undefined,
      error_code: this.error?.code,
      error_message: this.error?.message,
      player_name: this.opts.playerName ?? "vela-player",
      video_title: this.opts.title ?? undefined,
      page_url: location.href.slice(0, 990),
      exited: event === "viewend",
    };
  }

  send(event: string, beacon = false) {
    if (!this.started && event !== "error") return;
    const payload = this.snapshot(event);
    const body = JSON.stringify(payload);
    const fingerprint = body.replace(/"event":"[^"]*",/, "");
    if (fingerprint === this.lastSent && event === "heartbeat") return;
    this.lastSent = fingerprint;
    try {
      if (beacon && navigator.sendBeacon) {
        navigator.sendBeacon(this.opts.endpoint, body);
      } else {
        fetch(this.opts.endpoint, { method: "POST", body, keepalive: true, headers: { "Content-Type": "text/plain" } }).catch(() => {});
      }
    } catch {
      /* analytics must never break playback */
    }
  }

  destroy() {
    this.send("viewend", true);
    window.clearInterval(this.timer);
    this.cleanup.forEach((f) => f());
    void this.ended;
  }
}
