import { useState } from "react";
import { useOne } from "../lib/hooks";
import { compact } from "../lib/format";
import { PageHead, Panel, Segmented } from "../components/ui";
import { LineChart } from "../components/charts";

type Usage = {
  from: string;
  to: string;
  totals: { encoded_minutes: number; delivered_minutes: number; live_minutes: number; stored_minutes: number; stored_assets: number };
  rates: { encoding_per_minute: number; storage_per_minute_month: number; delivery_per_minute: number };
  estimated_cost: number;
  daily: { day: string; encoded_minutes: number; delivered_minutes: number; live_minutes: number; stored_minutes: number }[];
};

export function UsagePage() {
  const q = useOne<Usage>("usage", "/v1/usage");
  const [series, setSeries] = useState<"delivered_minutes" | "encoded_minutes" | "stored_minutes">("delivered_minutes");
  const u = q.data;
  const hasRates = u && (u.rates.encoding_per_minute || u.rates.delivery_per_minute || u.rates.storage_per_minute_month);
  return (
    <div className="page">
      <PageHead title="Usage" description={u ? `This month so far (${u.from} to ${u.to}).` : undefined} />
      <div className="stack">
        <div className="metrics">
          <div className="metric">
            <div className="label">Encoded</div>
            <div className="value">{compact(u?.totals.encoded_minutes ?? 0, 0)}</div>
            <div className="hint">minutes</div>
          </div>
          <div className="metric">
            <div className="label">Stored</div>
            <div className="value">{compact(u?.totals.stored_minutes ?? 0, 0)}</div>
            <div className="hint">minutes across {u?.totals.stored_assets ?? 0} videos</div>
          </div>
          <div className="metric">
            <div className="label">Delivered</div>
            <div className="value">{compact(u?.totals.delivered_minutes ?? 0, 0)}</div>
            <div className="hint">minutes watched</div>
          </div>
          <div className="metric">
            <div className="label">Live</div>
            <div className="value">{compact(u?.totals.live_minutes ?? 0, 0)}</div>
            <div className="hint">minutes recorded</div>
          </div>
          {hasRates ? (
            <div className="metric">
              <div className="label">Estimated cost</div>
              <div className="value">${(u!.estimated_cost ?? 0).toFixed(2)}</div>
            </div>
          ) : null}
        </div>
        <Panel
          title="Daily"
          actions={
            <Segmented
              value={series}
              onChange={setSeries}
              options={[
                { value: "delivered_minutes", label: "Delivered" },
                { value: "encoded_minutes", label: "Encoded" },
                { value: "stored_minutes", label: "Stored" },
              ]}
            />
          }
        >
          <LineChart points={(u?.daily ?? []).map((d) => ({ label: d.day.slice(5), value: d[series] }))} format={(n) => `${compact(n, 0)} min`} />
        </Panel>
        {!hasRates && (
          <p className="small muted">
            To show an estimated cost, set USAGE_RATE_ENCODING_PER_MIN, USAGE_RATE_STORAGE_PER_MIN_MONTH and USAGE_RATE_DELIVERY_PER_MIN on the API.
          </p>
        )}
      </div>
    </div>
  );
}
