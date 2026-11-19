import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, patch, post, put } from "../lib/api";
import { useList, useOne, useEnvKey, type LiveStream, type Asset } from "../lib/hooks";
import { dateTime, relative } from "../lib/format";
import { useSession } from "../lib/session";
import { PageHead, Panel, StatusBadge, Empty, Modal, Field, CopyField, Confirm, useToast, Loading } from "../components/ui";
import { Player } from "../components/Player";
import { IconPlus } from "../components/icons";

export function LiveListPage() {
  const list = useList<LiveStream>("live", "/v1/live-streams?limit=100", { refetch: () => 10_000 });
  const [creating, setCreating] = useState(false);
  const nav = useNavigate();
  const rows = list.data?.data ?? [];
  return (
    <div className="page">
      <PageHead
        title="Live streams"
        description="Broadcast from OBS, a hardware encoder or any RTMP/SRT source. Viewers watch over low-latency HLS."
        actions={
          <button className="btn primary" onClick={() => setCreating(true)}>
            <IconPlus /> New live stream
          </button>
        }
      />
      <Panel flush>
        {list.isLoading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty title="No live streams yet" action={<button className="btn primary" onClick={() => setCreating(true)}>Create a live stream</button>}>
            Each live stream has a permanent stream key, so you can reuse it for every broadcast.
          </Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Stream</th>
                <th>Status</th>
                <th>Recording</th>
                <th>Last live</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id} className="click" onClick={() => nav(`/live/${l.id}`)}>
                  <td>
                    <div className="t" style={{ fontWeight: 550 }}>
                      {l.title || "Untitled stream"}
                    </div>
                    <div className="mono muted" style={{ fontSize: 11.5 }}>
                      {l.id}
                    </div>
                  </td>
                  <td>
                    <StatusBadge status={l.status} />
                  </td>
                  <td className="small">{l.recording ? "On" : "Off"}</td>
                  <td className="small muted">{relative(l.last_active_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      {creating && <CreateLive onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateLive({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [policy, setPolicy] = useState<"public" | "signed">("public");
  const [recording, setRecording] = useState(true);
  const [latency, setLatency] = useState("low");
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  return (
    <Modal
      title="New live stream"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const l = await post<LiveStream>("/v1/live-streams", {
                  title: title || undefined,
                  playback_policies: [policy],
                  recording,
                  latency_mode: latency,
                  new_asset_settings: { playback_policies: [policy], title: title || undefined },
                });
                qc.invalidateQueries({ queryKey: ["live"] });
                nav(`/live/${l.id}`);
              } catch (err: any) {
                toast(err.message, true);
                setBusy(false);
              }
            }}
          >
            Create live stream
          </button>
        </>
      }
    >
      <Field label="Name">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Weekly town hall" autoFocus />
      </Field>
      <div className="grid-2">
        <Field label="Who can watch">
          <select className="input" value={policy} onChange={(e) => setPolicy(e.target.value as any)}>
            <option value="public">Anyone with the link</option>
            <option value="signed">Signed URLs only</option>
          </select>
        </Field>
        <Field label="Latency">
          <select className="input" value={latency} onChange={(e) => setLatency(e.target.value)}>
            <option value="low">Low (a few seconds)</option>
            <option value="standard">Standard (more stable)</option>
          </select>
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={recording} onChange={(e) => setRecording(e.target.checked)} />
        Record each broadcast as a video
      </label>
    </Modal>
  );
}

export function LivePage() {
  const { id } = useParams();
  const q = useOne<LiveStream>("live-one", `/v1/live-streams/${id}`, () => 5000);
  const l = q.data;
  const envKey = useEnvKey();
  const pid = l?.playback_ids[0];
  const token = useQuery({
    queryKey: ["preview-token", envKey, pid?.id],
    queryFn: () => get<{ token: string | null }>(`/v1/playback-ids/${pid!.id}/preview-token`),
    enabled: !!pid && pid.policy !== "public",
    staleTime: 50 * 60_000,
  });
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const { config } = useSession();
  const [reveal, setReveal] = useState(false);
  const [confirm, setConfirm] = useState<null | "reset" | "delete">(null);
  const [target, setTarget] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["live-one"] });

  if (q.isLoading) return <Loading />;
  if (!l) return <div className="page">Live stream not found.</div>;

  return (
    <div className="page">
      <div className="page-head">
        <div className="stack-sm">
          <Link to="/live" className="small">
            Live streams
          </Link>
          <div className="row">
            <h1>{l.title || "Untitled stream"}</h1>
            <StatusBadge status={l.status} />
            {l.status === "active" && !l.connected && <span className="badge warn">Encoder disconnected, waiting to reconnect</span>}
          </div>
        </div>
        <div className="row">
          {l.status === "active" && (
            <button
              className="btn"
              onClick={async () => {
                await put(`/v1/live-streams/${l.id}/complete`);
                toast("Ending the broadcast");
                refresh();
              }}
            >
              End broadcast
            </button>
          )}
          {l.status === "disabled" ? (
            <button className="btn" onClick={async () => (await put(`/v1/live-streams/${l.id}/enable`), refresh())}>
              Enable stream
            </button>
          ) : (
            <button className="btn" onClick={async () => (await put(`/v1/live-streams/${l.id}/disable`), refresh())}>
              Disable stream
            </button>
          )}
        </div>
      </div>

      <div className="split">
        <div className="stack">
          {l.status === "active" && pid && (pid.policy === "public" || token.data?.token) ? (
            <Player playbackId={pid.id} token={pid.policy === "public" ? null : token.data!.token} autoplay muted />
          ) : (
            <div className="player-frame center" style={{ color: "#d6dde6", textAlign: "center", padding: 24 }}>
              <div className="stack-sm" style={{ alignItems: "center" }}>
                <strong style={{ color: "#fff" }}>Waiting for your encoder</strong>
                <span className="small">Start streaming to the URL and key on the right. The preview appears here within a few seconds.</span>
              </div>
            </div>
          )}

          <Panel title="Connect your encoder" description="In OBS: Settings, Stream, Service: Custom.">
            <div className="stack">
              <Field label="RTMP server">
                <CopyField value={l.ingest.rtmp.url} label="Server URL" />
              </Field>
              {l.ingest.rtmps && (
                <Field label="RTMPS server">
                  <CopyField value={l.ingest.rtmps.url} label="Server URL" />
                </Field>
              )}
              <Field label="Stream key" hint="Anyone with this key can broadcast to your stream.">
                <div className="row">
                  <div className="grow">
                    <CopyField value={l.stream_key} display={reveal ? undefined : "•".repeat(24)} label="Stream key" />
                  </div>
                  <button className="btn sm" onClick={() => setReveal(!reveal)}>
                    {reveal ? "Hide" : "Show"}
                  </button>
                  <button className="btn sm" onClick={() => setConfirm("reset")}>
                    Reset key
                  </button>
                </div>
              </Field>
              <Field label="SRT URL" hint="For encoders that support SRT (lower latency, better on lossy networks).">
                <CopyField value={l.ingest.srt.url} display={reveal ? undefined : l.ingest.srt.url.replace(l.stream_key, "•".repeat(12))} label="SRT URL" />
              </Field>
            </div>
          </Panel>

          <Panel
            title="Restream"
            description="Send this broadcast to YouTube, Twitch, LinkedIn or any RTMP destination at the same time."
            actions={
              <button className="btn sm" onClick={() => setTarget(true)}>
                Add destination
              </button>
            }
          >
            {l.simulcast_targets.length === 0 ? (
              <p className="muted">No destinations.</p>
            ) : (
              <div className="stack-sm">
                {l.simulcast_targets.map((t) => (
                  <div key={t.id} className="row-between">
                    <span className="mono">{t.url}</span>
                    <div className="row">
                      <StatusBadge status={t.status} />
                      <button className="btn ghost sm" onClick={async () => (await del(`/v1/live-streams/${l.id}/simulcast-targets/${t.id}`), refresh())}>
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Recordings stream={l} />
        </div>

        <div className="stack">
          <Panel title="Playback">
            <div className="stack-sm">
              {l.playback_ids.map((p) => (
                <div key={p.id} className="stack-sm">
                  <span className={`badge ${p.policy === "public" ? "ok" : "info"}`} style={{ alignSelf: "flex-start" }}>
                    {p.policy === "public" ? "Public" : "Signed"}
                  </span>
                  <CopyField value={`${config?.stream_url}/${p.id}.m3u8`} label="HLS URL" />
                  <CopyField value={`${config?.stream_url}/embed/${p.id}`} label="Embed URL" />
                </div>
              ))}
            </div>
          </Panel>
          <Settings stream={l} onSaved={refresh} />
          <Panel title="Danger zone">
            <button className="btn danger" onClick={() => setConfirm("delete")}>
              Delete live stream
            </button>
          </Panel>
          <p className="small muted">Created {dateTime(l.created_at)}</p>
        </div>
      </div>

      {confirm === "reset" && (
        <Confirm
          title="Reset the stream key?"
          body="Encoders using the old key will stop working. You'll need to paste the new key into your encoder."
          confirmLabel="Reset key"
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            await post(`/v1/live-streams/${l.id}/reset-stream-key`);
            refresh();
            toast("Stream key reset");
          }}
        />
      )}
      {confirm === "delete" && (
        <Confirm
          title="Delete this live stream?"
          body="The stream key stops working. Past recordings stay in Videos."
          confirmLabel="Delete live stream"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            await del(`/v1/live-streams/${l.id}`);
            nav("/live");
          }}
        />
      )}
      {target && <AddTarget id={l.id} onClose={() => (setTarget(false), refresh())} />}
    </div>
  );
}

function Recordings({ stream }: { stream: LiveStream }) {
  const list = useList<Asset>("assets", `/v1/assets?live_stream_id=${stream.id}&limit=10`);
  const rows = list.data?.data ?? [];
  return (
    <Panel title="Recordings" description={stream.recording ? "Each broadcast is saved as a video." : "Recording is off for this stream."}>
      {rows.length === 0 ? (
        <p className="muted">No recordings yet.</p>
      ) : (
        <div className="stack-sm">
          {rows.map((a) => (
            <div key={a.id} className="row-between">
              <Link to={`/videos/${a.id}`}>{a.title || a.id}</Link>
              <div className="row">
                <StatusBadge status={a.status} />
                <span className="small muted">{relative(a.created_at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function Settings({ stream, onSaved }: { stream: LiveStream; onSaved: () => void }) {
  const [title, setTitle] = useState(stream.title ?? "");
  const [win, setWin] = useState(stream.reconnect_window);
  const [rec, setRec] = useState(stream.recording);
  const toast = useToast();
  return (
    <Panel title="Settings">
      <div className="stack">
        <Field label="Name">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Reconnect window (seconds)" hint="How long to wait for the encoder to come back before ending the broadcast.">
          <input className="input" type="number" min={0} max={1800} value={win} onChange={(e) => setWin(Number(e.target.value))} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={rec} onChange={(e) => setRec(e.target.checked)} />
          Record broadcasts
        </label>
        <button
          className="btn"
          style={{ alignSelf: "flex-start" }}
          onClick={async () => {
            await patch(`/v1/live-streams/${stream.id}`, { title: title || null, reconnect_window: win, recording: rec });
            onSaved();
            toast("Settings saved");
          }}
        >
          Save settings
        </button>
      </div>
    </Panel>
  );
}

function AddTarget({ id, onClose }: { id: string; onClose: () => void }) {
  const [url, setUrl] = useState("rtmp://a.rtmp.youtube.com/live2");
  const [key, setKey] = useState("");
  const toast = useToast();
  return (
    <Modal
      title="Add a restream destination"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              try {
                await post(`/v1/live-streams/${id}/simulcast-targets`, { url, stream_key: key || undefined });
                onClose();
              } catch (err: any) {
                toast(err.message, true);
              }
            }}
          >
            Add destination
          </button>
        </>
      }
    >
      <Field label="RTMP URL">
        <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} />
      </Field>
      <Field label="Stream key">
        <input className="input" value={key} onChange={(e) => setKey(e.target.value)} />
      </Field>
    </Modal>
  );
}
