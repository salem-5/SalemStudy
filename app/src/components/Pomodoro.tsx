import { useEffect, useMemo, useState } from 'react';
import { BellRing, Check, Pause, Play, Plus, RotateCcw, SkipForward, Volume2, X } from 'lucide-react';
import { fmtClock, PHASE_LABEL, pomodoro, remainingOf, usePomodoro, type Phase } from '../lib/pomodoro';
import { BarChart, StatTile } from './charts';
import { Modal } from './Dialogs';

const PHASES: Phase[] = ['focus', 'short', 'long'];

export function PomodoroChip({ onOpen }: { onOpen: () => void }) {
  const p = usePomodoro();
  const left = remainingOf(p);
  return (
    <div className={`pomo-chip ${p.status} ${p.phase}`}>
      <button type="button" className="pomo-chip-toggle" onClick={pomodoro.toggle} title={p.status === 'running' ? 'Pause' : 'Start'}>
        {p.status === 'running' ? <Pause /> : <Play />}
      </button>
      <button type="button" className="pomo-chip-time" onClick={onOpen} title={`${PHASE_LABEL[p.phase]} — open Focus`}>
        <span className="pomo-chip-phase">{p.phase === 'focus' ? 'focus' : 'break'}</span>
        <span className="pomo-chip-clock">{fmtClock(left)}</span>
      </button>
    </div>
  );
}

export function PomodoroAlarm() {
  const p = usePomodoro();
  if (!p.alarm) return null;
  const { ended, next } = p.alarm;
  const done = p.tasks.filter((t) => t.done).length;
  return (
    <Modal title={ended === 'focus' ? 'Focus session done' : 'Break over'} onClose={pomodoro.dismissAlarm}>
      <div className="pomo-alarm">
        <div className="pomo-alarm-bell" aria-hidden><BellRing /></div>
        <p>
          {ended === 'focus'
            ? `Nice work. ${done ? `${done} task${done === 1 ? '' : 's'} ticked off so far. ` : ''}Time for a ${next === 'long' ? 'long' : 'short'} break.`
            : 'Back to it. Pick a task and start the next focus session.'}
        </p>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={pomodoro.dismissAlarm}>Later</button>
          <button type="button" className="btn primary" autoFocus onClick={() => { pomodoro.dismissAlarm(); pomodoro.start(); }}>
            Start {PHASE_LABEL[next].toLowerCase()}
          </button>
        </div>
      </div>
    </Modal>
  );
}

const DAY = 864e5;
const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

function Ring({ fraction, phase }: { fraction: number; phase: Phase }) {
  const r = 108;
  const c = 2 * Math.PI * r;
  return (
    <svg className={`pomo-ring ${phase}`} viewBox="0 0 240 240" aria-hidden>
      <circle cx="120" cy="120" r={r} className="pomo-ring-track" />
      <circle cx="120" cy="120" r={r} className="pomo-ring-fill" strokeDasharray={c} strokeDashoffset={c * (1 - fraction)} />
    </svg>
  );
}

export function FocusPage() {
  const p = usePomodoro();
  const [draft, setDraft] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || (e.target as HTMLElement).closest('input, textarea, button, [contenteditable="true"]') || document.querySelector('.modal')) return;
      e.preventDefault();
      pomodoro.toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const left = remainingOf(p);
  const total = (p.phase === 'focus' ? p.settings.focus : p.phase === 'short' ? p.settings.short : p.settings.long) * 60_000;
  const fraction = total ? 1 - left / total : 0;

  const stats = useMemo(() => {
    const today = startOfDay(now);
    const focus = p.history.filter((s) => s.phase === 'focus');
    const minutesOn = (from: number, to: number) =>
      focus.filter((s) => s.end >= from && s.end < to).reduce((a, s) => a + (s.end - s.start) / 60_000, 0);
    const days = Array.from({ length: 7 }, (_, i) => {
      const from = today - (6 - i) * DAY;
      const d = new Date(from);
      return { label: d.toLocaleDateString(undefined, { weekday: 'short' }), title: d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }), values: { focus: Math.round(minutesOn(from, from + DAY)) } };
    });
    return {
      todayMinutes: Math.round(minutesOn(today, today + DAY)),
      todaySessions: focus.filter((s) => s.completed && s.end >= today).length,
      tasksToday: p.tasks.filter((t) => t.doneAt && t.doneAt >= today).length,
      weekMinutes: days.reduce((a, d) => a + d.values.focus, 0),
      days,
    };
  }, [p.history, p.tasks, now]);

  const open = p.tasks.filter((t) => !t.done);
  const done = p.tasks.filter((t) => t.done);

  return (
    <div className="page focus-page">
      <div className="focus-layout">
        <section className={`focus-timer ${p.phase}${p.status === 'running' ? ' running' : ''}`}>
          <div className="seg">
            {PHASES.map((ph) => (
              <button type="button" key={ph} className={`seg-item${p.phase === ph ? ' on' : ''}`} onClick={() => pomodoro.setPhase(ph)}>
                {PHASE_LABEL[ph]}
              </button>
            ))}
            <span className="seg-glider" style={{ transform: `translateX(${PHASES.indexOf(p.phase) * 100}%)` }} />
          </div>
          <div className="pomo-dial">
            <Ring fraction={fraction} phase={p.phase} />
            <div className="pomo-dial-center">
              <div className="pomo-phase">{p.status === 'paused' ? 'paused' : PHASE_LABEL[p.phase].toLowerCase()}</div>
              <div className="pomo-clock">{fmtClock(left)}</div>
              <div className="pomo-cycle" title="Focus sessions until the long break">
                {Array.from({ length: p.settings.every }, (_, i) => <i key={i} className={i < p.streak % p.settings.every || (p.streak > 0 && p.streak % p.settings.every === 0 && p.phase === 'long') ? 'on' : ''} />)}
              </div>
            </div>
          </div>
          <div className="pomo-now" title={open[0]?.text}>
            {p.phase === 'focus'
              ? open[0] ? <><span className="muted">Now</span>{open[0].text}</> : <span className="muted">Add a task to know what this session is for</span>
              : <span className="muted">Break — step away from the screen</span>}
          </div>
          <div className="pomo-actions">
            <button type="button" className="icon-btn pomo-side" onClick={pomodoro.reset} disabled={p.status === 'idle' && left === total} title="Reset"><RotateCcw /></button>
            <button type="button" className="btn primary pomo-main" onClick={pomodoro.toggle}>
              {p.status === 'running' ? <><Pause />Pause</> : <><Play />{p.status === 'paused' ? 'Resume' : 'Start'}</>}
            </button>
            <button type="button" className="icon-btn pomo-side" onClick={pomodoro.skip} title="Skip to the next phase"><SkipForward /></button>
          </div>
          <p className="muted small pomo-hint"><kbd>Space</kbd> starts or pauses</p>
        </section>

        <section className="focus-tasks card-panel">
          <div className="panel-title-row">
            <span className="panel-title">Tasks</span>
            <span className="muted small">{open.length} to do{done.length ? ` · ${done.length} done` : ''}</span>
          </div>
          <form className="task-add" onSubmit={(e) => { e.preventDefault(); pomodoro.addTask(draft); setDraft(''); }}>
            <input className="field-input" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="What will you work on?" />
            <button type="submit" className="btn" disabled={!draft.trim()}><Plus />Add</button>
          </form>
          <div className="task-scroll">
            <ul className="tasks stagger">
              {open.map((t, i) => (
                <li key={t.id} className={`task${i === 0 && p.phase === 'focus' ? ' current' : ''}`} style={{ '--i': i } as React.CSSProperties}>
                  <button type="button" className="check" onClick={() => pomodoro.toggleTask(t.id)} aria-label="Mark done" />
                  <span className="task-text">{t.text}</span>
                  <button type="button" className="task-x" onClick={() => pomodoro.removeTask(t.id)} aria-label="Remove"><X /></button>
                </li>
              ))}
              {!open.length && <li className="task empty muted">Nothing planned. Add what you want to finish before the timer ends.</li>}
            </ul>
            {!!done.length && (
              <>
                <div className="tasks-done-head">
                  <span className="muted small">Done · {done.length}</span>
                  <button type="button" className="link" onClick={pomodoro.clearDone}>clear</button>
                </div>
                <ul className="tasks done">
                  {done.map((t) => (
                    <li key={t.id} className="task done">
                      <button type="button" className="check on" onClick={() => pomodoro.toggleTask(t.id)} aria-label="Mark not done"><Check /></button>
                      <span className="task-text">{t.text}</span>
                      <button type="button" className="task-x" onClick={() => pomodoro.removeTask(t.id)} aria-label="Remove"><X /></button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </section>

        <div className="focus-stats">
          <StatTile label="Focus today" value={`${stats.todayMinutes}m`} sub={`${stats.todaySessions} session${stats.todaySessions === 1 ? '' : 's'}`} />
          <StatTile label="Tasks done today" value={stats.tasksToday} />
          <StatTile label="Last 7 days" value={`${Math.floor(stats.weekMinutes / 60)}h ${stats.weekMinutes % 60}m`} />
        </div>

        <section className="card-panel focus-chart">
          <div className="panel-title">Focus minutes, last 7 days</div>
          <BarChart label="Focus minutes per day, last 7 days" data={stats.days} series={[{ key: 'focus', name: 'Focus minutes', color: 'var(--series-1)' }]} format={(v) => `${Math.round(v)}m`} />
        </section>

        <section className="card-panel focus-settings">
          <div className="panel-title">Timer</div>
          <div className="pomo-settings">
            {([['focus', 'Focus'], ['short', 'Short break'], ['long', 'Long break']] as const).map(([k, label]) => (
              <label key={k} className="field">
                <span>{label} <i className="muted">min</i></span>
                <input type="number" min={1} max={180} value={p.settings[k]} onChange={(e) => pomodoro.updateSettings({ [k]: Math.max(1, Math.min(180, Number(e.target.value) || 1)) })} />
              </label>
            ))}
            <label className="field">
              <span>Long break every</span>
              <input type="number" min={2} max={12} value={p.settings.every} onChange={(e) => pomodoro.updateSettings({ every: Math.max(2, Math.min(12, Number(e.target.value) || 4)) })} />
            </label>
          </div>
          <label className="toggle"><input type="checkbox" checked={p.settings.autoStart} onChange={(e) => pomodoro.updateSettings({ autoStart: e.target.checked })} /> Start the next phase automatically</label>
          <label className="toggle"><input type="checkbox" checked={p.settings.sound} onChange={(e) => pomodoro.updateSettings({ sound: e.target.checked })} /> Chime when a phase ends</label>
          <div className="pomo-volume">
            <label className="field range">
              <span>Volume</span>
              <input type="range" min={0} max={1} step={0.05} value={p.settings.volume} onChange={(e) => pomodoro.updateSettings({ volume: Number(e.target.value) })} />
            </label>
            <button type="button" className="btn ghost" onClick={pomodoro.testSound}><Volume2 />Test</button>
          </div>
        </section>
      </div>
    </div>
  );
}
