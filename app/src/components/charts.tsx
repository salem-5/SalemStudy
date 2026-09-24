import { useLayoutEffect, useRef, useState } from 'react';

export type Series = { key: string; name: string; color: string };
export type Datum = { label: string; title?: string; values: Record<string, number> };

function useWidth(ref: React.RefObject<HTMLDivElement | null>, fallback = 640): number {
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function barPath(x: number, y: number, w: number, h: number, r = 4): string {
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function Tooltip({ x, y, children }: { x: number; y: number; children: React.ReactNode }) {
  return <div className="viz-tip" style={{ left: `${x}px`, top: `${y}px` }}>{children}</div>;
}

export function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <div className="viz-legend">
      {series.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.name}</span>)}
    </div>
  );
}

export function BarChart({ data, series, height = 180, format = (v: number) => String(Math.round(v)), label }: {
  data: Datum[];
  series: Series[];
  height?: number;
  format?: (v: number) => string;
  label: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const W = useWidth(wrap);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const pad = { l: 34, r: 8, t: 10, b: 22 };
  const plotH = height - pad.t - pad.b;
  const raw = niceMax(Math.max(0, ...data.map((d) => series.reduce((a, s) => a + (d.values[s.key] ?? 0), 0))));
  const max = raw < 2 ? 2 : raw % 2 ? raw + 1 : raw;
  const band = (W - pad.l - pad.r) / Math.max(1, data.length);
  const bw = Math.min(24, band * 0.62);
  const y = (v: number) => pad.t + plotH - (v / max) * plotH;
  const every = Math.ceil(data.length / Math.max(2, Math.floor(W / 70)));

  return (
    <div className="viz" ref={wrap} onMouseLeave={() => setHover(null)}>
      <svg width={W} height={height} viewBox={`0 0 ${W} ${height}`} role="img" aria-label={label}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line className="viz-grid" x1={pad.l} x2={W - pad.r} y1={y(max * f)} y2={y(max * f)} />
            <text className="viz-axis" x={pad.l - 6} y={y(max * f) + 3} textAnchor="end">{format(max * f)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = pad.l + band * i + band / 2;
          let acc = 0;
          const segs = series.map((s) => {
            const v = d.values[s.key] ?? 0;
            const top = y(acc + v);
            const bottom = y(acc);
            acc += v;
            return { s, v, top, bottom };
          }).filter((g) => g.v > 0);
          return (
            <g key={i}>
              {segs.map((g, j) => {
                const last = j === segs.length - 1;
                const h = g.bottom - g.top - (j > 0 ? 2 : 0);
                return last
                  ? <path key={g.s.key} d={barPath(cx - bw / 2, g.top, bw, h)} fill={g.s.color} />
                  : <rect key={g.s.key} x={cx - bw / 2} y={g.top} width={bw} height={Math.max(0, h)} fill={g.s.color} />;
              })}
              {i % every === 0 && <text className="viz-axis" x={cx} y={height - 6} textAnchor="middle">{d.label}</text>}
              <rect
                className="viz-hit"
                x={pad.l + band * i}
                y={pad.t}
                width={band}
                height={plotH}
                onMouseMove={(e) => {
                  const r = wrap.current!.getBoundingClientRect();
                  setHover({ i, x: e.clientX - r.left, y: e.clientY - r.top });
                }}
              />
            </g>
          );
        })}
        <line className="viz-base" x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} />
      </svg>
      {hover && (
        <Tooltip x={hover.x} y={hover.y}>
          <b>{data[hover.i].title ?? data[hover.i].label}</b>
          {series.map((s) => (
            <span key={s.key}><i style={{ background: s.color }} />{s.name} <em>{format(data[hover.i].values[s.key] ?? 0)}</em></span>
          ))}
        </Tooltip>
      )}
      <Legend series={series} />
    </div>
  );
}

export function LineChart({ points, height = 170, label, format = (v: number) => `${Math.round(v * 100)}%` }: {
  points: { label: string; title: string; y: number }[];
  height?: number;
  label: string;
  format?: (v: number) => string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const W = useWidth(wrap);
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 38, r: 12, t: 12, b: 22 };
  const plotW = W - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const x = (i: number) => pad.l + (points.length < 2 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number) => pad.t + plotH - v * plotH;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.y)}`).join('');

  return (
    <div
      className="viz"
      ref={wrap}
      onMouseLeave={() => setHover(null)}
      onMouseMove={(e) => {
        if (!points.length) return;
        const r = wrap.current!.getBoundingClientRect();
        const px = e.clientX - r.left;
        const i = points.length < 2 ? 0 : Math.round(((px - pad.l) / plotW) * (points.length - 1));
        setHover(Math.max(0, Math.min(points.length - 1, i)));
      }}
    >
      <svg width={W} height={height} viewBox={`0 0 ${W} ${height}`} role="img" aria-label={label}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line className="viz-grid" x1={pad.l} x2={W - pad.r} y1={y(f)} y2={y(f)} />
            <text className="viz-axis" x={pad.l - 6} y={y(f) + 3} textAnchor="end">{format(f)}</text>
          </g>
        ))}
        {hover !== null && <line className="viz-cross" x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + plotH} />}
        <path d={d} className="viz-line" />
        {points.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.y)} r={hover === i ? 5 : 4} className="viz-dot" />
        ))}
      </svg>
      {hover !== null && points[hover] && (
        <Tooltip x={x(hover)} y={y(points[hover].y)}>
          <b>{points[hover].title}</b>
          <span>{points[hover].label} <em>{format(points[hover].y)}</em></span>
        </Tooltip>
      )}
    </div>
  );
}

export function StatTile({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function MeterList({ rows, empty }: { rows: { key: string; label: string; value: number; detail: string }[]; empty: string }) {
  if (!rows.length) return <p className="muted small">{empty}</p>;
  return (
    <div className="meters">
      {rows.map((r) => (
        <div className="meter" key={r.key} title={r.detail}>
          <span className="meter-label">{r.label}</span>
          <span className="meter-track"><i style={{ width: `${Math.round(r.value * 100)}%` }} /></span>
          <span className="meter-value">{Math.round(r.value * 100)}%</span>
          <span className="meter-detail muted">{r.detail}</span>
        </div>
      ))}
    </div>
  );
}
