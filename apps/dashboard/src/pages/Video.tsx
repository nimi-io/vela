import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, patch, post, put } from "../lib/api";
import { useOne, useEnvKey, type Asset } from "../lib/hooks";
import { useSession } from "../lib/session";
import { bytes, dateTime, duration } from "../lib/format";
import { Panel, StatusBadge, CopyField, Field, Modal, Confirm, useToast, Loading, Code, Segmented } from "../components/ui";
import { Player } from "../components/Player";

function usePreviewToken(pid?: { id: string; policy: string }) {
  const envKey = useEnvKey();
  return useQuery({
    queryKey: ["preview-token", envKey, pid?.id],
    queryFn: () => get<{ token: string | null }>(`/v1/playback-ids/${pid!.id}/preview-token`),
    enabled: !!pid && pid.policy !== "public",
    staleTime: 50 * 60_000,
  });
}

export function VideoPage() {
  const { id } = useParams();
  // Remount per asset: React Router keeps this element mounted when only :id changes
  // (e.g. "Create clip" navigates from the source to the clip), and the child panels seed
  // local state from the asset (rename box, clip range, filmstrip, playback policy).
  return <VideoView key={id} id={id!} />;
}

function VideoView({ id }: { id: string }) {
  const asset = useOne<Asset>("asset", `/v1/assets/${id}`, (a) => (a?.status === "preparing" || a?.tracks.some((t) => t.status === "preparing") || a?.static_renditions?.status === "preparing" ? 3000 : false));
  const a = asset.data;
  const pid = a?.playback_ids[0];
  const token = usePreviewToken(pid);
  const playerRef = useRef<HTMLElement>(null);

  if (asset.isLoading) return <Loading />;
  if (!a) return <div className="page">Video not found. <Link to="/videos">Back to videos</Link></div>;
  const tok = pid?.policy === "public" ? null : (token.data?.token ?? null);
  const canPlay = a.status === "ready" && pid && (pid.policy === "public" || tok);

  return (
    <div className="page">
      <Header asset={a} />
      <div className="split">
        <div className="stack">
          {a.status === "ready" ? (
            canPlay ? (
              <div>
                <Player ref={playerRef} playbackId={pid!.id} token={tok} />
                {a.storyboard && <Filmstrip asset={a} pid={pid!.id} token={tok} playerRef={playerRef} />}
              </div>
            ) : (
              <div className="player-frame center" style={{ color: "#fff" }}>
                {pid ? "Preparing preview…" : "Add a playback ID to watch this video."}
              </div>
            )
          ) : (
            <ProcessingState asset={a} />
          )}
          {a.status === "ready" && <Insights asset={a} />}
          {a.status === "ready" && <Tracks asset={a} />}
          {a.status === "ready" && <Clip asset={a} playerRef={playerRef} />}
        </div>
        <div className="stack">
          <Details asset={a} />
          <PlaybackIds asset={a} />
          {a.status === "ready" && a.protection !== "drm" && <Downloads asset={a} token={tok} />}
          <Danger asset={a} />
        </div>
      </div>
    </div>
  );
}

function Header({ asset }: { asset: Asset }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(asset.title ?? "");
  const qc = useQueryClient();
  const toast = useToast();
  const save = async () => {
    await patch(`/v1/assets/${asset.id}`, { title: title || null });
    setEditing(false);
    qc.invalidateQueries({ queryKey: ["asset"] });
    toast("Title saved");
  };
  return (
    <div className="page-head">
      <div className="stack-sm" style={{ minWidth: 0 }}>
        <Link to="/videos" className="small">
          Videos
        </Link>
        {editing ? (
          <form className="row" onSubmit={(e) => (e.preventDefault(), save())}>
            <input className="input" style={{ width: 360, fontSize: 18 }} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
            <button className="btn primary sm">Save title</button>
            <button type="button" className="btn ghost sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <div className="row">
            <h1>{asset.title || "Untitled video"}</h1>
            <button className="btn ghost sm" onClick={() => setEditing(true)}>
              Rename
            </button>
          </div>
        )}
        <div className="row small muted">
          <StatusBadge status={asset.status} />
          <span className="mono">{asset.id}</span>
          {asset.is_live && <span className="badge">Live recording</span>}
        </div>
      </div>
    </div>
  );
}

function ProcessingState({ asset }: { asset: Asset }) {
  if (asset.status === "errored") {
    return (
      <div className="notice bad">
        <strong>Encoding failed.</strong> {asset.errors?.messages.join(" ")}
      </div>
    );
  }
  const labels: Record<string, string> = { ingesting: "Fetching the file", transcoding: "Encoding renditions", thumbnails: "Making thumbnails", uploading: "Saving to storage" };
  return (
    <div className="player-frame center" style={{ color: "#fff" }}>
      <div className="stack-sm" style={{ alignItems: "center" }}>
        <div>{asset.is_live && !asset.progress ? "Recording live stream" : (labels[asset.progress?.state ?? ""] ?? "Waiting for an encoder")}</div>
        <div className="progress" style={{ width: 240, background: "#2a3545" }}>
          <div style={{ width: `${asset.progress?.progress ?? 2}%` }} />
        </div>
        <div className="small" style={{ color: "#a9b3c0" }}>
          {Math.round(asset.progress?.progress ?? 0)}%
        </div>
      </div>
    </div>
  );
}

/** The storyboard laid out as a timeline: click a frame to jump there. */
function Filmstrip({ asset, pid, token, playerRef }: { asset: Asset; pid: string; token: string | null; playerRef: React.RefObject<HTMLElement> }) {
  const { config } = useSession();
  const [t, setT] = useState(0);
  const sb = useQuery({
    queryKey: ["storyboard", pid, !!token],
    queryFn: async () => {
      const r = await fetch(`${config!.stream_url}/${pid}/storyboard.json${token ? `?token=${encodeURIComponent(token)}` : ""}`);
      if (!r.ok) throw new Error("storyboard");
      return (await r.json()) as { url: string; tile_width: number; tile_height: number; tiles: { start: number; x: number; y: number }[] };
    },
    enabled: !!config,
    staleTime: Infinity,
  });
  useEffect(() => {
    const iv = setInterval(() => {
      const el = playerRef.current as any;
      if (el && typeof el.currentTime === "number") setT(el.currentTime);
    }, 250);
    return () => clearInterval(iv);
  }, [playerRef]);

  if (!sb.data || !sb.data.tiles.length) return null;
  const d = asset.duration ?? 1;
  const tiles = sb.data.tiles;
  const cols = Math.max(...tiles.map((x) => x.x)) / sb.data.tile_width + 1;
  const rows = Math.max(...tiles.map((x) => x.y)) / sb.data.tile_height + 1;
  const n = Math.min(tiles.length, 16);
  const pick = Array.from({ length: n }, (_, i) => tiles[Math.floor((i * tiles.length) / n)]!);
  const seek = (s: number) => {
    const el = playerRef.current as any;
    if (el) {
      el.currentTime = s;
      el.play?.().catch(() => {});
    }
  };
  return (
    <div className="filmstrip">
      <div className="filmstrip-frames">
        {pick.map((tile, i) => {
          const col = tile.x / sb.data!.tile_width;
          const row = tile.y / sb.data!.tile_height;
          return (
            <button
              key={i}
              aria-label={`Jump to ${duration(tile.start)}`}
              title={duration(tile.start)}
              onClick={() => seek(tile.start)}
              style={{
                aspectRatio: `${sb.data!.tile_width} / ${sb.data!.tile_height}`,
                backgroundImage: `url(${sb.data!.url})`,
                backgroundSize: `${cols * 100}% ${rows * 100}%`,
                backgroundPosition: `${cols > 1 ? (col / (cols - 1)) * 100 : 0}% ${rows > 1 ? (row / (rows - 1)) * 100 : 0}%`,
              }}
            />
          );
        })}
        <div className="filmstrip-head" style={{ left: `${(Math.min(t, d) / d) * 100}%` }} />
        {asset.ai?.chapters?.map((c) => (
          <div key={c.start_time} className="chapter-mark" title={c.title} style={{ left: `${(c.start_time / d) * 100}%` }} />
        ))}
      </div>
      <div className="filmstrip-marks">
        <span>0:00</span>
        <span>{duration(t)}</span>
        <span>{duration(d)}</span>
      </div>
    </div>
  );
}

function Details({ asset: a }: { asset: Asset }) {
  return (
    <Panel title="Details">
      <dl className="kv">
        <dt>Duration</dt>
        <dd>{duration(a.duration)}</dd>
        <dt>Resolution</dt>
        <dd>{a.max_width ? `${a.max_width} × ${a.max_height}` : "—"}</dd>
        <dt>Frame rate</dt>
        <dd>{a.max_frame_rate ? `${Math.round(a.max_frame_rate * 100) / 100} fps` : "—"}</dd>
        <dt>Aspect ratio</dt>
        <dd>{a.aspect_ratio ?? "—"}</dd>
        <dt>Renditions</dt>
        <dd>{a.renditions.length ? a.renditions.map((r) => r.name).join(", ") : "—"}</dd>
        <dt>Quality</dt>
        <dd style={{ textTransform: "capitalize" }}>{a.video_quality}</dd>
        <dt>Protection</dt>
        <dd>{a.protection === "drm" ? "DRM (Widevine, PlayReady, FairPlay)" : a.protection === "aes-128" ? "AES-128" : "None"}</dd>
        <dt>Created</dt>
        <dd>{dateTime(a.created_at)}</dd>
        {a.ready_at && (
          <>
            <dt>Ready</dt>
            <dd>{dateTime(a.ready_at)}</dd>
          </>
        )}
        {a.live_stream_id && (
          <>
            <dt>Live stream</dt>
            <dd>
              <Link to={`/live/${a.live_stream_id}`}>View stream</Link>
            </dd>
          </>
        )}
        {a.passthrough && (
          <>
            <dt>Passthrough</dt>
            <dd className="mono">{a.passthrough}</dd>
          </>
        )}
      </dl>
    </Panel>
  );
}

function PlaybackIds({ asset }: { asset: Asset }) {
  const { config } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [policy, setPolicy] = useState<"public" | "signed" | "drm">(asset.protection === "drm" ? "drm" : "public");
  const s = config?.stream_url ?? "";
  return (
    <Panel title="Playback" description="Use these URLs in any HLS player, or embed the hosted player.">
      <div className="stack">
        {asset.playback_ids.length === 0 && <p className="muted">No playback IDs. Add one to make this video watchable.</p>}
        {asset.playback_ids.map((p) => (
          <div key={p.id} className="stack-sm" style={{ borderBottom: "1px solid var(--line-2)", paddingBottom: 14 }}>
            <div className="row-between">
              <span className={`badge ${p.policy === "public" ? "ok" : "info"}`}>{p.policy === "public" ? "Public" : p.policy === "signed" ? "Signed" : "DRM"}</span>
              <button
                className="btn ghost sm"
                onClick={async () => {
                  await del(`/v1/assets/${asset.id}/playback-ids/${p.id}`);
                  qc.invalidateQueries({ queryKey: ["asset"] });
                  toast("Playback ID removed");
                }}
              >
                Remove
              </button>
            </div>
            <CopyField value={p.id} label="Playback ID" />
            <CopyField value={`${s}/${p.id}.m3u8`} label="HLS URL" />
            <CopyField value={`<iframe src="${s}/embed/${p.id}" style="width:100%;aspect-ratio:16/9;border:0" allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowfullscreen></iframe>`} label="Embed code" />
            {p.policy !== "public" && <p className="small muted">Append <code>?token=</code> with a JWT signed by one of your signing keys. See Signing keys for an example.</p>}
          </div>
        ))}
        <div className="row">
          <select className="input" style={{ width: 160 }} value={policy} onChange={(e) => setPolicy(e.target.value as any)} aria-label="Policy">
            <option value="public">Public</option>
            <option value="signed">Signed</option>
            {asset.protection === "drm" && <option value="drm">DRM</option>}
          </select>
          <button
            className="btn"
            onClick={async () => {
              try {
                await post(`/v1/assets/${asset.id}/playback-ids`, { policy });
                qc.invalidateQueries({ queryKey: ["asset"] });
              } catch (err: any) {
                toast(err.message, true);
              }
            }}
          >
            Add playback ID
          </button>
        </div>
      </div>
    </Panel>
  );
}

function Downloads({ asset, token }: { asset: Asset; token: string | null }) {
  const { config } = useSession();
  const qc = useQueryClient();
  const pid = asset.playback_ids[0];
  const files = asset.static_renditions?.files ?? [];
  return (
    <Panel title="Downloads" description="MP4 and audio files people can save.">
      <div className="stack-sm">
        <select
          className="input"
          value={asset.mp4_support}
          aria-label="Downloadable files"
          onChange={async (e) => {
            await put(`/v1/assets/${asset.id}/mp4-support`, { mp4_support: e.target.value });
            qc.invalidateQueries({ queryKey: ["asset"] });
          }}
        >
          <option value="none">No downloads</option>
          <option value="capped-1080p">MP4 up to 1080p</option>
          <option value="audio-only">Audio only (M4A)</option>
          <option value="standard">High, medium, low MP4 + audio</option>
        </select>
        {files.map((f) => (
          <div key={f.name} className="row-between small">
            <span className="mono">{f.name}</span>
            {f.status === "ready" && pid ? (
              <a href={`${config?.stream_url}/${pid.id}/${f.name}?${token ? `token=${encodeURIComponent(token)}&` : ""}download=${encodeURIComponent(asset.title || asset.id)}`}>Download {bytes(f.filesize)}</a>
            ) : (
              <StatusBadge status={f.status} />
            )}
          </div>
        ))}
      </div>
    </Panel>
  );
}

const LANGS = [
  ["en", "English"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["pt", "Portuguese"],
  ["it", "Italian"],
  ["nl", "Dutch"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["zh", "Chinese"],
  ["hi", "Hindi"],
  ["ar", "Arabic"],
  ["yo", "Yoruba"],
  ["sw", "Swahili"],
];

function Tracks({ asset }: { asset: Asset }) {
  const { config } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [translating, setTranslating] = useState<string | null>(null);
  const text = asset.tracks.filter((t) => t.type === "text");
  const refresh = () => qc.invalidateQueries({ queryKey: ["asset"] });
  return (
    <Panel
      title="Captions and subtitles"
      description="Shown as selectable tracks in every player."
      actions={
        <>
          <button className="btn sm" onClick={() => setAdding(true)}>
            Add from URL
          </button>
          <button
            className="btn sm"
            disabled={!config?.transcription_enabled}
            title={config?.transcription_enabled ? undefined : "Set TRANSCRIPTION_PROVIDER to enable"}
            onClick={async () => {
              await post(`/v1/assets/${asset.id}/generate-subtitles`, { language_code: "en" });
              refresh();
              toast("Generating captions");
            }}
          >
            Generate captions
          </button>
        </>
      }
    >
      {text.length === 0 ? (
        <p className="muted">No captions yet. Upload a WebVTT or SRT file, or generate them from the audio.</p>
      ) : (
        <div className="stack-sm">
          {text.map((t) => (
            <div key={t.id} className="row-between">
              <div>
                <strong>{t.name}</strong> <span className="muted small">{t.language_code}, {t.text_source}</span>
              </div>
              <div className="row">
                <StatusBadge status={t.status} />
                {t.status === "ready" && config?.llm_enabled && (
                  <button className="btn ghost sm" onClick={() => setTranslating(t.id)}>
                    Translate
                  </button>
                )}
                <button
                  className="btn ghost sm"
                  onClick={async () => {
                    await del(`/v1/assets/${asset.id}/tracks/${t.id}`);
                    refresh();
                  }}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {adding && <AddTrack asset={asset} onClose={() => (setAdding(false), refresh())} />}
      {translating && (
        <Translate
          onClose={() => setTranslating(null)}
          onPick={async (lang, name) => {
            await post(`/v1/assets/${asset.id}/tracks/${translating}/translate`, { language_code: lang, name });
            setTranslating(null);
            refresh();
            toast("Translation started");
          }}
        />
      )}
    </Panel>
  );
}

function AddTrack({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [lang, setLang] = useState("en");
  const [name, setName] = useState("English");
  const [cc, setCc] = useState(false);
  const toast = useToast();
  return (
    <Modal
      title="Add subtitles from a URL"
      description="WebVTT, SRT and most other subtitle formats work."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!url}
            onClick={async () => {
              try {
                await post(`/v1/assets/${asset.id}/tracks`, { url, type: "text", language_code: lang, name, closed_captions: cc });
                toast("Subtitles added");
                onClose();
              } catch (err: any) {
                toast(err.message, true);
              }
            }}
          >
            Add subtitles
          </button>
        </>
      }
    >
      <Field label="File URL">
        <input className="input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/captions.vtt" />
      </Field>
      <div className="grid-2">
        <Field label="Language">
          <select className="input" value={lang} onChange={(e) => (setLang(e.target.value), setName(LANGS.find((l) => l[0] === e.target.value)?.[1] ?? e.target.value))}>
            {LANGS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Label shown to viewers">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={cc} onChange={(e) => setCc(e.target.checked)} />
        These are closed captions (include sound descriptions)
      </label>
    </Modal>
  );
}

function Translate({ onClose, onPick }: { onClose: () => void; onPick: (lang: string, name: string) => void }) {
  const [lang, setLang] = useState("es");
  return (
    <Modal
      title="Translate subtitles"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onPick(lang, `${LANGS.find((l) => l[0] === lang)?.[1] ?? lang} (translated)`)}>
            Translate
          </button>
        </>
      }
    >
      <Field label="Into">
        <select className="input" value={lang} onChange={(e) => setLang(e.target.value)}>
          {LANGS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </Field>
    </Modal>
  );
}

function Insights({ asset }: { asset: Asset }) {
  const { config } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const ai = asset.ai;
  if (!config?.llm_enabled && !ai?.summary) return null;
  return (
    <Panel
      title="Summary and chapters"
      actions={
        config?.llm_enabled && (
          <button
            className="btn sm"
            onClick={async () => {
              await post(`/v1/assets/${asset.id}/insights`);
              toast("Analysing the transcript. This takes a minute.");
              setTimeout(() => qc.invalidateQueries({ queryKey: ["asset"] }), 30_000);
            }}
          >
            {ai?.summary ? "Regenerate" : "Generate"}
          </button>
        )
      }
    >
      {ai?.summary ? (
        <div className="stack-sm">
          <p style={{ maxWidth: "72ch" }}>{ai.summary}</p>
          {!!ai.tags?.length && (
            <div className="row">
              {ai.tags.map((t) => (
                <span key={t} className="badge">
                  {t}
                </span>
              ))}
            </div>
          )}
          {!!ai.chapters?.length && (
            <ol className="small" style={{ margin: "6px 0 0", paddingLeft: 20 }}>
              {ai.chapters.map((c) => (
                <li key={c.start_time}>
                  <span className="mono">{duration(c.start_time)}</span> {c.title}
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : (
        <p className="muted">Get a summary, topic tags and chapter markers from what's said in the video.</p>
      )}
    </Panel>
  );
}

function Clip({ asset, playerRef }: { asset: Asset; playerRef: React.RefObject<HTMLElement> }) {
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(Math.min(30, asset.duration ?? 30));
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const toast = useToast();
  const now = () => Math.round(((playerRef.current as any)?.currentTime ?? 0) * 10) / 10;
  return (
    <Panel title="Make a clip" description="Creates a new video from part of this one.">
      <div className="row">
        <Field label="Start (seconds)">
          <div className="row">
            <input className="input" style={{ width: 110 }} type="number" min={0} step={0.1} value={start} onChange={(e) => setStart(Number(e.target.value))} />
            <button className="btn sm" type="button" onClick={() => setStart(now())}>
              Use playhead
            </button>
          </div>
        </Field>
        <Field label="End (seconds)">
          <div className="row">
            <input className="input" style={{ width: 110 }} type="number" min={0} step={0.1} value={end} onChange={(e) => setEnd(Number(e.target.value))} />
            <button className="btn sm" type="button" onClick={() => setEnd(now())}>
              Use playhead
            </button>
          </div>
        </Field>
        <button
          className="btn primary"
          style={{ alignSelf: "flex-end" }}
          disabled={busy || end <= start}
          onClick={async () => {
            setBusy(true);
            try {
              const c = await post<Asset>(`/v1/assets/${asset.id}/clips`, {
                start_time: start,
                end_time: end,
                playback_policies: [asset.playback_ids[0]?.policy === "drm" ? "drm" : (asset.playback_ids[0]?.policy ?? "public")],
              });
              toast("Clip created");
              nav(`/videos/${c.id}`);
            } catch (err: any) {
              toast(err.message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          Create clip ({duration(Math.max(0, end - start))})
        </button>
      </div>
    </Panel>
  );
}

function Danger({ asset }: { asset: Asset }) {
  const [confirm, setConfirm] = useState(false);
  const [tab, setTab] = useState<"json" | "api">("api");
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { config } = useSession();
  return (
    <Panel title="Developer">
      <div className="stack">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "api", label: "API request" },
            { value: "json", label: "Raw JSON" },
          ]}
        />
        {tab === "api" ? (
          <Code>{`curl ${config?.api_url ?? ""}/v1/assets/${asset.id} \\\n  -u $TOKEN_ID:$TOKEN_SECRET`}</Code>
        ) : (
          <Code>{JSON.stringify(asset, null, 2).slice(0, 6000)}</Code>
        )}
        <button className="btn danger" onClick={() => setConfirm(true)}>
          Delete video
        </button>
      </div>
      {confirm && (
        <Confirm
          title="Delete this video?"
          body="Its playback URLs stop working and all stored files are removed. This can't be undone."
          confirmLabel="Delete video"
          danger
          onClose={() => setConfirm(false)}
          onConfirm={async () => {
            await del(`/v1/assets/${asset.id}`);
            qc.invalidateQueries({ queryKey: ["assets"] });
            toast("Video deleted");
            nav("/videos");
          }}
        />
      )}
    </Panel>
  );
}
