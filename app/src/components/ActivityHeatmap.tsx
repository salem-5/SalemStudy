import { useLayoutEffect, useMemo, useRef, useState } from 'react';

/**
 * GitHub-style activity: one square per day, columns are weeks (Monday on
 * top), shade grows with the number of study actions. It shows as many recent
 * weeks as fit the width (up to a year), ending with this week on the right.
 */

const DAY = 864e5;
const MAX_WEEKS = 53;
const CELL = 11;
const GAP = 3;
const DAY_LABELS = 30;
const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

export function ActivityHeatmap({ times, onPickDay }: {
  times: number[];
  /** Clicking a day asks for its breakdown. Omit it and the squares are inert. */
  onPickDay?: (day: number) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [WEEKS, setWeeks] = useState(26);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const fit = () => setWeeks(Math.max(8, Math.min(MAX_WEEKS, Math.floor((el.clientWidth - DAY_LABELS + GAP) / (CELL + GAP)))));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { weeks, max, total, streak, best, months } = useMemo(() => {
    const counts = new Map<number, number>();
    for (const t of times) counts.set(startOfDay(t), (counts.get(startOfDay(t)) ?? 0) + 1);
    const today = startOfDay(Date.now());
    // The grid ends with the week containing today; weeks start on Monday.
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
        // A partial first month would crowd the next label; drop it.
        if (prev && w - prev.w < 3) months.pop();
        if (!prev || prev.label !== label) months.push({ w, label });
      }
    });
    return { weeks, max: Math.max(1, ...counts.values()), total, streak, best, months };
  }, [times, WEEKS]);

  // Four shades by quartile of the busiest day; 0 stays empty.
  const level = (n: number) => (n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4)));

  return (
    <div className="heatmap" ref={wrap} onMouseLeave={() => setTip(null)}>
      <div className="heatmap-summary">
        <span><b>{total}</b> study actions in the last {WEEKS >= 52 ? 'year' : WEEKS >= 9 ? `${Math.round(WEEKS / 4.35)} months` : `${WEEKS} weeks`}</span>
        <span className="muted">current streak <b>{streak}</b> day{streak === 1 ? '' : 's'} · longest <b>{best}</b></span>
      </div>
      <div className="heatmap-scroll">
        <div className="heatmap-months" style={{ gridTemplateColumns: `repeat(${WEEKS}, var(--cell))` }}>
          {months.map((m) => <span key={`${m.w}-${m.label}`} style={{ gridColumn: m.w + 1 }}>{m.label}</span>)}
        </div>
        <div className="heatmap-body">
          <div className="heatmap-days"><span>Mon</span><span /><span>Wed</span><span /><span>Fri</span><span /><span /></div>
          <div className="heatmap-grid" style={{ gridTemplateColumns: `repeat(${WEEKS}, var(--cell))` }}>
            {weeks.map((col, w) => col.map((c, d) => (
              <span
                key={c.t}
                role={onPickDay && c.n ? 'button' : undefined}
                tabIndex={onPickDay && c.n ? 0 : undefined}
                aria-label={onPickDay && c.n ? `${c.n} action${c.n === 1 ? '' : 's'} on ${new Date(c.t).toDateString()}` : undefined}
                className={`heat l${level(c.n)}${c.future ? ' future' : ''}${onPickDay && c.n ? ' pickable' : ''}`}
                style={{ gridColumn: w + 1, gridRow: d + 1 }}
                onClick={() => { if (c.n && !c.future) onPickDay?.(c.t); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && c.n && !c.future) onPickDay?.(c.t); }}
                onMouseEnter={(e) => {
                  if (c.future) return;
                  const r = wrap.current!.getBoundingClientRect();
                  const b = (e.target as HTMLElement).getBoundingClientRect();
                  const date = new Date(c.t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
                  const hint = onPickDay && c.n ? ' · click to see what' : '';
                  setTip({ x: b.left - r.left + b.width / 2, y: b.top - r.top, text: `${c.n || 'No'} action${c.n === 1 ? '' : 's'} · ${date}${hint}` });
                }}
              />
            )))}
          </div>
        </div>
      </div>
      <div className="heatmap-legend"><span className="muted">Less</span>{[0, 1, 2, 3, 4].map((l) => <span key={l} className={`heat l${l}`} />)}<span className="muted">More</span></div>
      {tip && <div className="viz-tip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>}
    </div>
  );
}
