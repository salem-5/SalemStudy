import { fmtInt } from '../lib/usage';

export type Bar = { label: string; value: number; sub?: string };

/** Minimal horizontal bar chart; no chart library needed. */
export function BarChart({ data, unit, empty }: { data: Bar[]; unit?: string; empty?: string }) {
  if (!data.length) return <div className="muted">{empty ?? 'No usage recorded yet.'}</div>;
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="chart">
      {data.map((d) => (
        <div className="chart-row" key={d.label}>
          <span className="chart-label" title={d.sub ?? d.label}>{d.label}</span>
          <span className="chart-track">
            <i style={{ width: `${Math.max(1.5, (d.value / max) * 100)}%` }} />
          </span>
          <span className="chart-value">{fmtInt(d.value)}{unit ? ` ${unit}` : ''}</span>
        </div>
      ))}
    </div>
  );
}
