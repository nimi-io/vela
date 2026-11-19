import { Link, useNavigate } from "react-router-dom";
import { useList, useOne, thumbUrl, type Asset, type LiveStream } from "../lib/hooks";
import { useSession } from "../lib/session";
import { compact, duration, hours, relative } from "../lib/format";
import { PageHead, Panel, StatusBadge, Empty } from "../components/ui";

export function OverviewPage() {
  const { env, config, me } = useSession();
  const nav = useNavigate();
  const stats = useOne<any>("data-overview", "/v1/data/overview?timeframe=7d");
  const realtime = useOne<any>("data-realtime", "/v1/data/realtime", () => 15_000);
  const assets = useList<Asset>("assets", "/v1/assets?limit=6");
  const live = useList<LiveStream>("live", "/v1/live-streams?limit=50", { refetch: () => 10_000 });
  const usage = useOne<any>("usage", "/v1/usage");

  const onAir = (live.data?.data ?? []).filter((l) => l.status === "active");
  const firstName = me?.user.name?.split(" ")[0];

  return (
    <div className="page">
      <PageHead title={firstName ? `Hello, ${firstName}` : "Overview"} description={`${env?.name} environment, last 7 days.`} />
      <div className="stack">
        <div className="metrics">
          <div className="metric">
            <div className="label">Watching now</div>
            <div className="value">{compact(realtime.data?.concurrent_viewers)}</div>
          </div>
          <div className="metric">
            <div className="label">Views</div>
            <div className="value">{compact(stats.data?.views)}</div>
          </div>
          <div className="metric">
            <div className="label">Watch time</div>
            <div className="value">{hours(stats.data?.watch_time_seconds ?? 0)}</div>
          </div>
          <div className="metric">
            <div className="label">Viewer experience</div>
            <div className="value">{stats.data?.views ? Math.round(stats.data.experience_score) : "—"}</div>
            <div className="hint">out of 100</div>
          </div>
          <div className="metric">
            <div className="label">Stored</div>
            <div className="value">{compact(usage.data?.totals.stored_minutes ?? 0, 0)}</div>
            <div className="hint">minutes of video</div>
          </div>
        </div>

        {onAir.length > 0 && (
          <Panel title="On air now">
            <div className="stack-sm">
              {onAir.map((l) => (
                <div key={l.id} className="row-between">
                  <Link to={`/live/${l.id}`}>{l.title || l.id}</Link>
                  <StatusBadge status="active" />
                </div>
              ))}
            </div>
          </Panel>
        )}

        <Panel flush title="Recent videos" actions={<Link to="/videos" className="btn sm">All videos</Link>}>
          {(assets.data?.data.length ?? 0) === 0 ? (
            <Empty title="Nothing uploaded yet" action={<Link className="btn primary" to="/videos">Upload a video</Link>}>
              Your first upload will show up here with its status and stats.
            </Empty>
          ) : (
            <table className="table">
              <tbody>
                {assets.data!.data.map((a) => {
                  const t = thumbUrl(config?.stream_url, a);
                  return (
                    <tr key={a.id} className="click" onClick={() => nav(`/videos/${a.id}`)}>
                      <td>
                        <div className="title-cell">
                          <div className="thumb" style={t ? { backgroundImage: `url(${t})` } : undefined}>
                            {a.duration != null && <span className="dur">{duration(a.duration)}</span>}
                          </div>
                          <div className="t">{a.title || "Untitled video"}</div>
                        </div>
                      </td>
                      <td>
                        <StatusBadge status={a.status} />
                      </td>
                      <td className="small muted num">{relative(a.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>

        <div className="grid-2">
          <Panel title="Send your first API request">
            <div className="stack-sm">
              <p className="muted">Create an access token under API keys, then import a video:</p>
              <pre className="code">{`curl ${config?.api_url}/v1/assets \\
  -u $TOKEN_ID:$TOKEN_SECRET \\
  -H "Content-Type: application/json" \\
  -d '{"input":"https://example.com/video.mp4","playback_policy":"public"}'`}</pre>
            </div>
          </Panel>
          <Panel title="Go live">
            <div className="stack-sm">
              <p className="muted">Create a live stream, then point OBS or any RTMP/SRT encoder at the ingest URL. Recordings become videos automatically.</p>
              <Link to="/live" className="btn" style={{ alignSelf: "flex-start" }}>
                Create a live stream
              </Link>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
