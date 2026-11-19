import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { post, uploadFile } from "../lib/api";
import { useList, thumbUrl, type Asset } from "../lib/hooks";
import { useSession } from "../lib/session";
import { duration, relative } from "../lib/format";
import { PageHead, Panel, StatusBadge, Empty, Pager, Modal, Field, useToast, Loading } from "../components/ui";
import { IconUpload, IconLink } from "../components/icons";

export type AssetSettings = {
  title?: string;
  playback_policy: "public" | "signed" | "drm";
  protection?: "none" | "aes-128";
  video_quality: "basic" | "plus" | "premium";
  max_resolution_tier: "1080p" | "1440p" | "2160p";
  mp4_support: "none" | "capped-1080p" | "audio-only" | "standard";
  normalize_audio: boolean;
  captions?: string; // language code for auto-generated subtitles
  generate_insights?: boolean;
};

export const defaultSettings: AssetSettings = {
  playback_policy: "public",
  protection: "none",
  video_quality: "plus",
  max_resolution_tier: "1080p",
  mp4_support: "none",
  normalize_audio: false,
};

export function toApiSettings(s: AssetSettings, url?: string) {
  const input: any[] = [];
  if (url || s.captions) {
    input.push({ ...(url ? { url } : {}), ...(s.captions ? { generated_subtitles: [{ language_code: s.captions, name: `${s.captions} (auto)` }] } : {}) });
  }
  return {
    ...(input.length ? { input } : {}),
    title: s.title || undefined,
    playback_policies: [s.playback_policy],
    protection: s.playback_policy === "drm" ? "drm" : s.protection,
    video_quality: s.video_quality,
    max_resolution_tier: s.max_resolution_tier,
    mp4_support: s.playback_policy === "drm" ? "none" : s.mp4_support,
    normalize_audio: s.normalize_audio,
    generate_insights: s.generate_insights || undefined,
  };
}

export function AssetSettingsFields({ value, onChange }: { value: AssetSettings; onChange: (v: AssetSettings) => void }) {
  const { config } = useSession();
  const set = <K extends keyof AssetSettings>(k: K, v: AssetSettings[K]) => onChange({ ...value, [k]: v });
  return (
    <>
      <Field label="Title">
        <input className="input" value={value.title ?? ""} onChange={(e) => set("title", e.target.value)} placeholder="Optional" />
      </Field>
      <div className="grid-2">
        <Field label="Who can watch" hint={value.playback_policy === "drm" ? "Encrypted with Widevine, PlayReady and FairPlay. Needs a signed token." : value.playback_policy === "signed" ? "Viewers need a token signed with your signing key." : "Anyone with the link can watch."}>
          <select className="input" value={value.playback_policy} onChange={(e) => set("playback_policy", e.target.value as any)}>
            <option value="public">Anyone with the link</option>
            <option value="signed">Signed URLs only</option>
            <option value="drm">DRM protected</option>
          </select>
        </Field>
        {value.playback_policy !== "drm" && (
          <Field label="Encryption" hint="AES-128 encrypts segments; keys are only served to authorised players.">
            <select className="input" value={value.protection} onChange={(e) => set("protection", e.target.value as any)}>
              <option value="none">None</option>
              <option value="aes-128">AES-128</option>
            </select>
          </Field>
        )}
        <Field label="Quality">
          <select className="input" value={value.video_quality} onChange={(e) => set("video_quality", e.target.value as any)}>
            <option value="basic">Basic (fewer renditions, smallest files)</option>
            <option value="plus">Plus</option>
            <option value="premium">Premium (highest bitrates)</option>
          </select>
        </Field>
        <Field label="Maximum resolution">
          <select className="input" value={value.max_resolution_tier} onChange={(e) => set("max_resolution_tier", e.target.value as any)}>
            <option value="1080p">1080p</option>
            <option value="1440p">1440p</option>
            <option value="2160p">4K</option>
          </select>
        </Field>
        {value.playback_policy !== "drm" && (
          <Field label="Downloadable files">
            <select className="input" value={value.mp4_support} onChange={(e) => set("mp4_support", e.target.value as any)}>
              <option value="none">None</option>
              <option value="capped-1080p">MP4 up to 1080p</option>
              <option value="audio-only">Audio only (M4A)</option>
              <option value="standard">High, medium, low MP4 + audio</option>
            </select>
          </Field>
        )}
        <Field label="Auto captions" hint={config?.transcription_enabled ? "Generated from the audio." : "Set TRANSCRIPTION_PROVIDER to enable."}>
          <select className="input" value={value.captions ?? ""} disabled={!config?.transcription_enabled} onChange={(e) => set("captions", e.target.value || undefined)}>
            <option value="">Off</option>
            {[
              ["en", "English"],
              ["es", "Spanish"],
              ["fr", "French"],
              ["de", "German"],
              ["pt", "Portuguese"],
              ["it", "Italian"],
              ["ja", "Japanese"],
              ["hi", "Hindi"],
              ["auto", "Detect language"],
            ].map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={value.normalize_audio} onChange={(e) => set("normalize_audio", e.target.checked)} />
        Normalize loudness
      </label>
      {config?.llm_enabled && (
        <label className="check">
          <input type="checkbox" checked={!!value.generate_insights} onChange={(e) => set("generate_insights", e.target.checked)} />
          Generate a summary, tags and chapters
        </label>
      )}
    </>
  );
}

type UploadItem = { id: string; name: string; progress: number; error?: string; done?: boolean };

export function VideosPage() {
  const { config } = useSession();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [settings, setSettings] = useState<AssetSettings>(defaultSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [showUrl, setShowUrl] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const qs = new URLSearchParams({ page: String(page), limit: "20", ...(q ? { q } : {}), ...(status ? { status } : {}) });
  const list = useList<Asset>("assets", `/v1/assets?${qs}`, { refetch: (d) => (d?.some((a) => a.status === "preparing") ? 3000 : false) });

  const startUploads = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const local = `${file.name}-${Date.now()}`;
      setUploads((u) => [...u, { id: local, name: file.name, progress: 0 }]);
      const update = (p: Partial<UploadItem>) => setUploads((u) => u.map((x) => (x.id === local ? { ...x, ...p } : x)));
      try {
        const s = toApiSettings({ ...settings, title: settings.title || file.name.replace(/\.[^.]+$/, "") });
        const { input, ...rest } = s as any;
        const up = await post<{ id: string; url: string }>("/v1/uploads", { new_asset_settings: rest, cors_origin: location.origin });
        await uploadFile(up.url, file, (p) => update({ progress: p }));
        const done = await post<{ asset_id: string | null }>(`/v1/uploads/${up.id}/complete`);
        // Auto captions are queued as a track; the worker fills it in once encoding finishes.
        if (settings.captions && done?.asset_id) {
          await post(`/v1/assets/${done.asset_id}/generate-subtitles`, { language_code: settings.captions }).catch(() => {});
        }
        update({ progress: 1, done: true });
        qc.invalidateQueries({ queryKey: ["assets"] });
        setTimeout(() => setUploads((u) => u.filter((x) => x.id !== local)), 2500);
      } catch (err: any) {
        update({ error: err.message });
        toast(err.message, true);
      }
    }
  };

  const assets = list.data?.data ?? [];
  return (
    <div className="page">
      <PageHead
        title="Videos"
        description="Upload files or import from a URL. Each video is encoded into adaptive streams and gets its own playback URLs."
        actions={
          <>
            <button className="btn" onClick={() => setShowUrl(true)}>
              <IconLink /> Import from URL
            </button>
            <button className="btn primary" onClick={() => fileRef.current?.click()}>
              <IconUpload /> Upload
            </button>
          </>
        }
      />
      <input ref={fileRef} type="file" accept="video/*,audio/*" multiple hidden onChange={(e) => e.target.files && startUploads(e.target.files)} />

      <div className="stack">
        <div
          className={`dropzone${over ? " over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            if (e.dataTransfer.files.length) startUploads(e.dataTransfer.files);
          }}
          onClick={() => fileRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && fileRef.current?.click()}
        >
          <strong>Drop video or audio files here</strong>, or click to choose.
          <div className="small muted" style={{ marginTop: 4 }}>
            New uploads: {settings.playback_policy === "public" ? "public" : settings.playback_policy === "signed" ? "signed URLs" : "DRM"}, {settings.video_quality} quality, up to {settings.max_resolution_tier}.{" "}
            <button
              className="btn ghost sm"
              onClick={(e) => {
                e.stopPropagation();
                setShowSettings(true);
              }}
            >
              Change upload settings
            </button>
          </div>
        </div>

        {uploads.length > 0 && (
          <Panel title="Uploading">
            <div className="stack-sm">
              {uploads.map((u) => (
                <div key={u.id} className="row-between">
                  <span>{u.name}</span>
                  {u.error ? (
                    <span className="badge bad">{u.error}</span>
                  ) : u.done ? (
                    <span className="badge ok">Uploaded, processing</span>
                  ) : (
                    <div className="row">
                      <div className="progress">
                        <div style={{ width: `${u.progress * 100}%` }} />
                      </div>
                      <span className="small muted">{Math.round(u.progress * 100)}%</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Panel>
        )}

        <Panel
          flush
          title="All videos"
          actions={
            <>
              <input className="input" style={{ width: 220 }} placeholder="Search title or ID" value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} aria-label="Search videos" />
              <select className="input" style={{ width: 150 }} value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))} aria-label="Filter by status">
                <option value="">Any status</option>
                <option value="ready">Ready</option>
                <option value="preparing">Processing</option>
                <option value="errored">Failed</option>
              </select>
            </>
          }
        >
          {list.isLoading ? (
            <Loading />
          ) : assets.length === 0 ? (
            <Empty title={q || status ? "No videos match" : "No videos yet"} action={!q && !status && <button className="btn primary" onClick={() => fileRef.current?.click()}>Upload your first video</button>}>
              {q || status ? "Try a different search or filter." : "Upload a file or import one from a URL. It'll be ready to stream in a few minutes."}
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Video</th>
                    <th>Status</th>
                    <th>Access</th>
                    <th>Resolution</th>
                    <th>Added</th>
                  </tr>
                </thead>
                <tbody>
                  {assets.map((a) => {
                    const t = thumbUrl(config?.stream_url, a);
                    return (
                      <tr key={a.id} className="click" onClick={() => nav(`/videos/${a.id}`)}>
                        <td>
                          <div className="title-cell">
                            <div className="thumb" style={t ? { backgroundImage: `url(${t})` } : undefined}>
                              {a.duration != null && <span className="dur">{duration(a.duration)}</span>}
                            </div>
                            <div style={{ minWidth: 0 }}>
                              <div className="t">{a.title || "Untitled video"}</div>
                              <div className="id">{a.id}</div>
                            </div>
                          </div>
                        </td>
                        <td>
                          <div className="stack-sm" style={{ gap: 4, alignItems: "flex-start" }}>
                            <StatusBadge status={a.status} />
                            {a.status === "preparing" && a.progress && (
                              <div className="progress">
                                <div style={{ width: `${a.progress.progress}%` }} />
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="small">
                          {a.protection === "drm" ? "DRM" : a.playback_ids.some((p) => p.policy === "public") ? "Public" : a.playback_ids.length ? "Signed" : "No playback ID"}
                          {a.protection === "aes-128" ? ", AES-128" : ""}
                        </td>
                        <td className="small">{a.max_height ? `${Math.min(a.max_width ?? 0, a.max_height)}p` : a.status === "ready" ? "Audio" : "—"}</td>
                        <td className="small muted">{relative(a.created_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <Pager page={page} limit={20} total={list.data?.pagination?.total} onPage={setPage} />
        </Panel>
      </div>

      {showSettings && (
        <Modal title="Upload settings" description="Applied to the next files you upload." onClose={() => setShowSettings(false)} footer={<button className="btn primary" onClick={() => setShowSettings(false)}>Done</button>}>
          <AssetSettingsFields value={settings} onChange={setSettings} />
        </Modal>
      )}
      {showUrl && <ImportModal onClose={() => setShowUrl(false)} />}
    </div>
  );
}

function ImportModal({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [s, setS] = useState<AssetSettings>(defaultSettings);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const nav = useNavigate();
  const qc = useQueryClient();
  return (
    <Modal
      title="Import from URL"
      description="We'll download the file and encode it. The URL must be publicly reachable."
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!url || busy}
            onClick={async () => {
              setBusy(true);
              try {
                const a = await post<Asset>("/v1/assets", toApiSettings(s, url));
                qc.invalidateQueries({ queryKey: ["assets"] });
                toast("Import started");
                nav(`/videos/${a.id}`);
              } catch (err: any) {
                toast(err.message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            Import video
          </button>
        </>
      }
    >
      <Field label="File URL">
        <input className="input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/video.mp4" autoFocus />
      </Field>
      <AssetSettingsFields value={s} onChange={setS} />
    </Modal>
  );
}
