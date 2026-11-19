import { useEffect, useRef, useState } from "react";

type Point = { label: string; value: number };

/** Minimal responsive area/line chart with a hover readout. */
export function LineChart({ points, format = (n) => String(Math.round(n)), height = 180, color = "var(--accent)" }: { points: Point[]; format?: (n: number) => string; height?: number; color?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(640);
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e!.contentRect.width))));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const H = height;
  const pad = { l: 44, r: 12, t: 12, b: 24 };
  if (!points.length) return <div ref={box} className="empty small">No data in this period yet.</div>;
  const max = Math.max(1, ...points.map((p) => p.value));
  const nice = niceMax(max);
  const x = (i: number) => pad.l + (points.length === 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (points.length - 1));
  const y = (v: number) => pad.t + (1 - v / nice) * (H - pad.t - pad.b);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join("");
  const area = `${line}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z`;
  const ticks = [0, nice / 2, nice];
  const every = Math.ceil(points.length / 6);
  return (
    <div ref={box} style={{ position: "relative" }}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} onMouseLeave={() => setHover(null)} role="img">
        <g className="grid">
          {ticks.map((t) => (
            <line key={t} x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
          ))}
        </g>
        <g className="axis">
          {ticks.map((t) => (
            <text key={t} x={pad.l - 8} y={y(t) + 4} textAnchor="end">
              {format(t)}
            </text>
          ))}
          {points.map((p, i) =>
            i % every === 0 ? (
              <text key={i} x={x(i)} y={H - 6} textAnchor="middle">
                {p.label}
              </text>
            ) : null,
          )}
        </g>
        <path d={area} fill={color} opacity={0.1} />
        <path d={line} fill="none" stroke={color} strokeWidth={2} />
        {points.length <= 31 && points.map((p, i) => <circle key={`d${i}`} cx={x(i)} cy={y(p.value)} r={2.5} fill={color} />)}
        {points.map((p, i) => (
          <rect key={i} x={x(i) - (W / points.length) / 2} y={0} width={W / points.length} height={H} fill="transparent" onMouseEnter={() => setHover(i)} />
        ))}
        {hover !== null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="var(--ink-3)" strokeDasharray="3 3" />
            <circle cx={x(hover)} cy={y(points[hover]!.value)} r={4} fill={color} />
          </>
        )}
      </svg>
      {hover !== null && (
        <div className="small" style={{ position: "absolute", top: 0, right: 0, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 6, padding: "4px 8px" }}>
          {points[hover]!.label}: <strong>{format(points[hover]!.value)}</strong>
        </div>
      )}
    </div>
  );
}

function niceMax(v: number) {
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
}

export function BarList({ rows, format = (n) => String(n) }: { rows: { label: string; value: number }[]; format?: (n: number) => string }) {
  if (!rows.length) return <div className="muted small">No data yet.</div>;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="bars">
      {rows.map((r) => (
        <div className="bar-row" key={r.label}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.label}>
            {r.label}
          </span>
          <div className="track">
            <div className="fill" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
          <span className="n">{format(r.value)}</span>
        </div>
      ))}
    </div>
  );
}
