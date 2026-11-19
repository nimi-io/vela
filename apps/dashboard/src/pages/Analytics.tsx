import { useState } from "react";
import { useOne } from "../lib/hooks";
import { compact, hours, pct } from "../lib/format";
import { PageHead, Panel, Segmented } from "../components/ui";
import { LineChart, BarList } from "../components/charts";

type TF = "24h" | "7d" | "30d" | "90d";
type Metric = "views" | "watch_time_seconds" | "avg_startup_ms" | "rebuffer_percentage" | "experience_score";

const METRICS: { value: Metric; label: string; fmt: (n: number) => string }[] = [
  { value: "views", label: "Views", fmt: (n) => compact(n) },
  { value: "watch_time_seconds", label: "Watch time", fmt: (n) => hours(n) },
  { value: "avg_startup_ms", label: "Startup time", fmt: (n) => `${(n / 1000).toFixed(2)} s` },
  { value: "rebuffer_percentage", label: "Rebuffering", fmt: (n) => pct(n) },
  { value: "experience_score", label: "Experience score", fmt: (n) => String(Math.round(n)) },
];

const DIMENSIONS = [
  { value: "asset_id", label: "Top videos" },
  { value: "browser", label: "Browsers" },
  { value: "os", label: "Operating systems" },
  { value: "device_type", label: "Devices" },
  { value: "country", label: "Countries" },
];

export function AnalyticsPage() {
  const [tf, setTf] = useState<TF>("7d");
  const [metric, setMetric] = useState<Metric>("views");
  const overview = useOne<any>("data-overview", `/v1/data/overview?timeframe=${tf}`);
  const series = useOne<any>("data-ts", `/v1/data/timeseries?timeframe=${tf}`);
  const realtime = useOne<any>("data-realtime", "/v1/data/realtime", () => 10_000);
  const m = METRICS.find((x) => x.value === metric)!;
  const o = overview.data;

  const points = (series.data?.points ?? []).map((p: any) => ({
    label: new Date(p.time).toLocaleString(undefined, series.data.bucket === "hour" ? { hour: "numeric" } : { month: "short", day: "numeric" }),
    value: Number(p[metric] ?? 0),
  }));

  return (
    <div className="page">
      <PageHead
        title="Analytics"
        description="Collected automatically by the Vela player. Startup time, rebuffering and failures show how good playback feels to viewers."
        actions={
          <Segmented<TF>
            value={tf}
            onChange={setTf}
            options={[
              { value: "24h", label: "24 hours" },
              { value: "7d", label: "7 days" },
              { value: "30d", label: "30 days" },
              { value: "90d", label: "90 days" },
            ]}
          />
        }
      />
      <div className="stack">
        <div className="metrics">
          <div className="metric">
            <div className="label">Watching now</div>
            <div className="value">{compact(realtime.data?.concurrent_viewers)}</div>
          </div>
          <div className="metric">
            <div className="label">Views</div>
            <div className="value">{compact(o?.views)}</div>
            <div className="hint">{compact(o?.unique_viewers)} unique viewers</div>
          </div>
          <div className="metric">
            <div className="label">Watch time</div>
            <div className="value">{hours(o?.watch_time_seconds ?? 0)}</div>
          </div>
          <div className="metric">
            <div className="label">Startup time</div>
            <div className="value">{o?.views ? `${((o.avg_startup_ms ?? 0) / 1000).toFixed(2)} s` : "—"}</div>
          </div>
          <div className="metric">
            <div className="label">Rebuffering</div>
            <div className="value">{o?.views ? pct(o.rebuffer_percentage) : "—"}</div>
            <div className="hint">of watch time</div>
          </div>
          <div className="metric">
            <div className="label">Failed views</div>
            <div className="value">{o?.views ? pct(o.failure_percentage) : "—"}</div>
          </div>
        </div>

        <Panel
          title={m.label}
          actions={
            <select className="input" style={{ width: 190 }} value={metric} onChange={(e) => setMetric(e.target.value as Metric)} aria-label="Metric">
              {METRICS.map((x) => (
                <option key={x.value} value={x.value}>
                  {x.label}
                </option>
              ))}
            </select>
          }
        >
          <LineChart points={points} format={m.fmt} />
        </Panel>

        <div className="grid-2">
          {DIMENSIONS.map((d) => (
            <Breakdown key={d.value} dimension={d.value} title={d.label} tf={tf} />
          ))}
          <Panel title="Watching now, by video">
            <BarList rows={(realtime.data?.top ?? []).map((t: any) => ({ label: t.title || t.asset_id || t.live_stream_id || "Unknown", value: t.viewers }))} />
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Breakdown({ dimension, title, tf }: { dimension: string; title: string; tf: string }) {
  const q = useOne<any[]>("data-bd", `/v1/data/breakdown?dimension=${dimension}&timeframe=${tf}&limit=8`);
  return (
    <Panel title={title}>
      <BarList rows={(q.data ?? []).map((r) => ({ label: String(r.label ?? r.value), value: r.views }))} format={(n) => compact(n)} />
    </Panel>
  );
}
