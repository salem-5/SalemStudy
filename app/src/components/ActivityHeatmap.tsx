import { useMemo, useRef, useState } from 'react';

const DAY = 864e5;
/** A few recent weeks, big enough to read and click, rather than a year of specks. */
const WEEKS = 8;
const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** Days in a row with any study, counting today if you have studied yet and yesterday otherwise. */
export function streakOf(times: number[]): number {
  const days = new Set(times.map(startOfDay));
  const today = startOfDay(Date.now());
  let streak = 0;
  for (let t = days.has(today) ? today : today - DAY; days.has(t); t -= DAY) streak++;
  return streak;
}

export function ActivityHeatmap({ times, onPickDay }: {
  times: number[];
  onPickDay?: (day: number) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);

  const { weeks, max, total, streak, best, months } = useMemo(() => {
    const counts = new Map<number, number>();
    for (const t of times) counts.set(startOfDay(t), (counts.get(startOfDay(t)) ?? 0) + 1);
    const today = startOfDay(Date.now());
    const dow = (new Date(today).getDay() + 6) % 7;
    const start = today - dow * DAY - (WEEKS - 1) * 7 * DAY;
    const weeks: { t: number; n: number; future: boolean }[][] = [];
    for (let w = 0; w < WEEKS; w++) {
      const col = [];
      for (let d = 0; d < 7; d++) {
        const t = start + (w * 7 + d) * DAY;
        col.push({ t, n: counts.get(t) ?? 0, future: t > today });
      }
      weeks.push(col);
    }
    let streak = 0;
    for (let t = counts.has(today) ? today : today - DAY; counts.has(t); t -= DAY) streak++;
    let best = 0;
    let run = 0;
    let total = 0;
    for (let t = start; t <= today; t += DAY) { run = counts.has(t) ? run + 1 : 0; best = Math.max(best, run); total += counts.get(t) ?? 0; }
    const months: { w: number; label: string }[] = [];
    weeks.forEach((col, w) => {
      const first = new Date(col[0].t);
      if (w === 0 || first.getDate() <= 7) {
        const label = first.toLocaleDateString(undefined, { month: 'short' });
        const prev = months[months.length - 1];
        if (prev && w - prev.w < 2) months.pop();
        if (!prev || prev.label !== label) months.push({ w, label });
      }
    });
    return { weeks, max: Math.max(1, ...counts.values()), total, streak, best, months };
  }, [times]);

  const today = startOfDay(Date.now());
  const level = (n: number) => (n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4)));

  return (
    <div className="heatmap" ref={wrap} onMouseLeave={() => setTip(null)}>
      <div className="heatmap-summary">
        <span><b>{total}</b> study action{total === 1 ? '' : 's'} in the last {WEEKS} weeks</span>
        <span className="muted">current streak <b>{streak}</b> day{streak === 1 ? '' : 's'} · longest <b>{best}</b></span>
      </div>
      {/* One grid: month names along the top, day names down the side, a square per day. */}
      <div className="heatmap-grid" style={{ gridTemplateColumns: `auto repeat(${WEEKS}, minmax(0, 1fr))` }}>
        {months.map((m) => <span key={`${m.w}-${m.label}`} className="heatmap-month" style={{ gridColumn: m.w + 2, gridRow: 1 }}>{m.label}</span>)}
        {['Mon', '', 'Wed', '', 'Fri', '', ''].map((d, i) => d && <span key={d} className="heatmap-day" style={{ gridColumn: 1, gridRow: i + 2 }}>{d}</span>)}
        {weeks.map((col, w) => col.map((c, d) => (
          <span
            key={c.t}
            role={onPickDay && c.n ? 'button' : undefined}
            tabIndex={onPickDay && c.n ? 0 : undefined}
            aria-label={onPickDay && c.n ? `${c.n} action${c.n === 1 ? '' : 's'} on ${new Date(c.t).toDateString()}` : undefined}
            className={`heat l${level(c.n)}${c.future ? ' future' : ''}${onPickDay && c.n ? ' pickable' : ''}${c.t === today ? ' today' : ''}`}
            style={{ gridColumn: w + 2, gridRow: d + 2 }}
            onClick={() => { if (c.n && !c.future) onPickDay?.(c.t); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && c.n && !c.future) onPickDay?.(c.t); }}
            onMouseEnter={(e) => {
              if (c.future) return;
              const r = wrap.current!.getBoundingClientRect();
              const b = (e.target as HTMLElement).getBoundingClientRect();
              const date = new Date(c.t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
              const hint = onPickDay && c.n ? ' · click to see what' : '';
              setTip({ x: b.left - r.left + b.width / 2, y: b.top - r.top, text: `${c.n || 'No'} action${c.n === 1 ? '' : 's'} · ${date}${hint}` });
            }}
          />
        )))}
      </div>
      <div className="heatmap-legend"><span className="muted">Less</span>{[0, 1, 2, 3, 4].map((l) => <span key={l} className={`heat l${l}`} />)}<span className="muted">More</span></div>
      {tip && <div className="viz-tip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>}
    </div>
  );
}
