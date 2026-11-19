// @ts-ignore - Shaka's UI build is a UMD bundle without ESM typings
import shakaModule from "shaka-player/dist/shaka-player.ui.js";
import controlsCss from "shaka-player/dist/controls.css?inline";
import { ViewMonitor } from "./analytics";

const shaka: any = (shakaModule as any) ?? (window as any).shaka;

const scriptOrigin = (() => {
  try {
    const src = (document.currentScript as HTMLScriptElement | null)?.src;
    return src ? new URL(src).origin : null;
  } catch {
    return null;
  }
})();

type PlaybackInfo = {
  type: "asset" | "live";
  status: string;
  title?: string | null;
  hls: string;
  dash?: string | null;
  poster?: string;
  storyboard?: string | null;
  chapters?: string | null;
  protection?: "none" | "aes-128" | "drm";
  drm?: {
    provider: "clearkey" | "proxy";
    clearkey?: string;
    widevine?: string | null;
    playready?: string | null;
    fairplay?: string | null;
    fairplay_certificate?: string | null;
  } | null;
};

let cssInjected = false;
function injectCss() {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement("style");
  style.textContent = `${controlsCss}
vela-player{display:block;position:relative;background:#000;aspect-ratio:var(--vela-aspect,16/9);overflow:hidden;color:#fff;font-family:system-ui,sans-serif}
vela-player .vela-root{position:absolute;inset:0}
vela-player .vela-root video{width:100%;height:100%;background:#000}
vela-player .vela-msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;font-size:15px;background:rgba(0,0,0,.65);z-index:10}
vela-player .vela-msg[hidden]{display:none}
vela-player .vela-wm{position:absolute;z-index:5;pointer-events:none;font-size:14px;opacity:.35;text-shadow:0 0 3px #000;transition:top 1s,left 1s;white-space:nowrap}`;
  document.head.appendChild(style);
}

const isApple = () => /Apple/.test(navigator.vendor) && !/Chrome|Chromium|Edg/.test(navigator.userAgent);

/**
 * <vela-player playback-id="..." token="..." drm-token="..." autoplay muted></vela-player>
 */
export class VelaPlayerElement extends HTMLElement {
  static get observedAttributes() {
    return ["playback-id", "token", "drm-token", "stream-url", "max-resolution", "watermark-text"];
  }

  private player: any = null;
  private ui: any = null;
  private monitor: ViewMonitor | null = null;
  private root!: HTMLDivElement;
  private msg!: HTMLDivElement;
  private wm: HTMLDivElement | null = null;
  private wmTimer: number | undefined;
  private retryTimer: number | undefined;
  private loadSeq = 0;
  video!: HTMLVideoElement;

  connectedCallback() {
    if (this.root) return;
    injectCss();
    this.root = document.createElement("div");
    this.root.className = "vela-root";
    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.video.setAttribute("playsinline", "");
    this.video.crossOrigin = "anonymous";
    if (this.hasAttribute("muted")) this.video.muted = true;
    if (this.hasAttribute("loop")) this.video.loop = true;
    if (this.hasAttribute("autoplay")) this.video.autoplay = true;
    this.root.appendChild(this.video);
    this.msg = document.createElement("div");
    this.msg.className = "vela-msg";
    this.msg.hidden = true;
    this.appendChild(this.root);
    this.appendChild(this.msg);
    void this.load();
  }

  disconnectedCallback() {
    void this.teardown();
  }

  attributeChangedCallback(name: string, oldV: string | null, newV: string | null) {
    if (!this.root || oldV === newV) return;
    if (name === "watermark-text") return this.setupWatermark();
    void this.load();
  }

  get streamUrl() {
    return (this.getAttribute("stream-url") ?? (window as any).VELA_STREAM_URL ?? scriptOrigin ?? location.origin).replace(/\/$/, "");
  }

  play() {
    return this.video.play();
  }
  pause() {
    this.video.pause();
  }
  get currentTime() {
    return this.video.currentTime;
  }
  set currentTime(t: number) {
    this.video.currentTime = t;
  }

  private show(text: string | null) {
    this.msg.hidden = !text;
    this.msg.textContent = text ?? "";
  }

  private async teardown() {
    window.clearTimeout(this.retryTimer);
    window.clearInterval(this.wmTimer);
    this.monitor?.destroy();
    this.monitor = null;
    try {
      await this.ui?.destroy();
    } catch {}
    try {
      await this.player?.destroy();
    } catch {}
    this.ui = null;
    this.player = null;
  }

  private async load() {
    const seq = ++this.loadSeq;
    const pid = this.getAttribute("playback-id");
    if (!pid) return this.show("Missing playback-id");
    await this.teardown();
    if (seq !== this.loadSeq) return;

    const base = this.streamUrl;
    const token = this.getAttribute("token");
    const tq = token ? `?token=${encodeURIComponent(token)}` : "";

    let info: PlaybackInfo;
    try {
      const res = await fetch(`${base}/${pid}/playback-info${tq}`);
      if (res.status === 412 || res.status === 503) {
        this.show("This video is being prepared. It will start automatically.");
        this.retryTimer = window.setTimeout(() => this.load(), 5000);
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        return this.show(err?.error?.messages?.[0] ?? `Unable to load video (${res.status})`);
      }
      info = await res.json();
    } catch {
      return this.show("Network error while loading the video");
    }
    if (info.type === "live" && info.status !== "active") {
      this.show("The live stream hasn't started yet. It will play automatically when it does.");
      this.retryTimer = window.setTimeout(() => this.load(), 5000);
      return;
    }
    if (seq !== this.loadSeq) return;

    shaka.polyfill.installAll();
    if (!shaka.Player.isBrowserSupported()) return this.show("This browser can't play this video");

    const player = new shaka.Player();
    await player.attach(this.video);
    this.player = player;

    const drmToken = this.getAttribute("drm-token") ?? token;
    const dq = drmToken ? `?token=${encodeURIComponent(drmToken)}` : "";
    const config: any = {
      streaming: { lowLatencyMode: info.type === "live" },
      abr: { enabled: true },
    };
    const maxRes = this.getAttribute("max-resolution");
    if (maxRes) config.restrictions = { maxHeight: parseInt(maxRes, 10) };

    let manifest = info.hls;
    if (info.protection === "drm" && info.drm) {
      const servers: Record<string, string> = {};
      const d = info.drm;
      if (d.provider === "clearkey" && d.clearkey) servers["org.w3.clearkey"] = d.clearkey + dq;
      if (d.widevine) servers["com.widevine.alpha"] = d.widevine + dq;
      if (d.playready) servers["com.microsoft.playready"] = d.playready + dq;
      if (d.fairplay) servers["com.apple.fps"] = d.fairplay + dq;
      config.drm = { servers };
      if (d.fairplay && d.fairplay_certificate) {
        config.drm.advanced = { "com.apple.fps": { serverCertificateUri: d.fairplay_certificate } };
      }
      // Safari + FairPlay uses HLS; everything else uses DASH (Widevine/PlayReady/ClearKey).
      manifest = isApple() && d.fairplay ? info.hls : (info.dash ?? info.hls);
    }
    player.configure(config);

    const primary = this.getAttribute("primary-color");
    this.ui = new shaka.ui.Overlay(player, this.root, this.video);
    this.ui.configure({
      overflowMenuButtons: ["captions", "quality", "language", "chapter", "picture_in_picture", "playback_rate", "cast"],
      seekBarColors: primary ? { base: "rgba(255,255,255,.3)", buffered: "rgba(255,255,255,.54)", played: primary } : undefined,
      enableTooltips: true,
    });

    if (!this.hasAttribute("no-analytics")) {
      this.monitor = new ViewMonitor(this.video, {
        endpoint: `${base}/data/events`,
        playbackId: pid,
        viewerId: this.getAttribute("viewer-id"),
        title: this.getAttribute("video-title") ?? info.title ?? null,
      });
    }
    player.addEventListener("error", (e: any) => {
      const err = e.detail;
      this.monitor?.setError(String(err?.code ?? "unknown"), String(err?.message ?? err?.data?.[0] ?? "Playback error"));
    });

    this.video.poster = this.getAttribute("poster") ?? (info.type === "asset" ? (info.poster ?? "") : "");
    try {
      const start = this.getAttribute("start-time");
      await player.load(manifest, start ? Number(start) : undefined);
      this.show(null);
    } catch (err: any) {
      this.monitor?.setError(String(err?.code ?? "load"), String(err?.message ?? "Load failed"));
      return this.show(`Playback failed (${err?.code ?? "error"})`);
    }
    if (info.storyboard) player.addThumbnailsTrack(info.storyboard, "text/vtt").catch(() => {});
    if (info.chapters) player.addChaptersTrack(info.chapters, "en").catch(() => {});
    this.setupWatermark();
    this.dispatchEvent(new CustomEvent("loaded", { detail: info }));
  }

  /** Moving, semi-transparent viewer watermark (e.g. email) to discourage screen recording. */
  private setupWatermark() {
    window.clearInterval(this.wmTimer);
    const text = this.getAttribute("watermark-text");
    if (!text) {
      this.wm?.remove();
      this.wm = null;
      return;
    }
    if (!this.wm) {
      this.wm = document.createElement("div");
      this.wm.className = "vela-wm";
      this.root.appendChild(this.wm);
    }
    this.wm.textContent = text;
    const move = () => {
      if (!this.wm) return;
      this.wm.style.top = `${5 + Math.random() * 80}%`;
      this.wm.style.left = `${5 + Math.random() * 70}%`;
    };
    move();
    this.wmTimer = window.setInterval(move, 8000);
  }
}

if (!customElements.get("vela-player")) customElements.define("vela-player", VelaPlayerElement);

export default VelaPlayerElement;
