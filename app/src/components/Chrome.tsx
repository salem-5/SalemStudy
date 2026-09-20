import type { AssignmentList, AssignmentSummary, BridgeInfo, Course, Status } from '../types';
import { fmtDue, parseDue, relTime } from '../lib/format';
import { AssignmentListSkeleton } from './Skeleton';

export function Sidebar({ list, loading, selected, multi, onSelect, courses, section, onSection, onRefresh, onContext, onAiSettings }: {
  list: AssignmentList | null;
  loading: boolean;
  selected: number | null;
  multi: number[];
  onSelect: (id: number, additive?: boolean) => void;
  courses: Course[];
  section: string | undefined;
  onSection: (s: string) => void;
  onRefresh: () => void;
  onContext?: (a: AssignmentSummary, e: React.MouseEvent) => void;
  onAiSettings: () => void;
}) {
  return (
    <aside className="sidebar">
      <div className="side-top">
        <select value={section ?? ''} onChange={(e) => onSection(e.target.value)} title="Course">
          {courses.map((c) => (
            <option key={c.id} value={c.sectionId}>{c.course} · {c.section} · {c.term}</option>
          ))}
        </select>
        <button type="button" className="icon-btn" onClick={onRefresh} title="Reload assignment list">⟳</button>
      </div>
      {loading && !list && <AssignmentListSkeleton />}
      {list && (
        <>
          <Group title="CURRENT" items={list.current} selected={selected} multi={multi} onSelect={onSelect} onContext={onContext} />
          <Group title="PAST" items={list.past} selected={selected} multi={multi} onSelect={onSelect} onContext={onContext} />
        </>
      )}
      <div className="side-foot">
        <button type="button" className="btn ghost side-ai" onClick={onAiSettings} title="API key, balance and usage">
          ⚙ AI settings
        </button>
      </div>
    </aside>
  );
}

function Group({ title, items, selected, multi, onSelect, onContext }: {
  title: string;
  items: AssignmentSummary[];
  selected: number | null;
  multi: number[];
  onSelect: (id: number, additive?: boolean) => void;
  onContext?: (a: AssignmentSummary, e: React.MouseEvent) => void;
}) {
  return (
    <div className="side-group">
      <div className="side-title">{title} <span className="muted">{items.length}</span></div>
      {items.map((a) => {
        const due = parseDue(a.due);
        const late = due.getTime() < Date.now();
        const soon = !late && due.getTime() - Date.now() < 864e5;
        const pct = a.total ? Math.round(((a.score ?? 0) / a.total) * 100) : 0;
        const picked = multi.includes(a.id);
        return (
          <button
            type="button"
            key={a.id}
            className={`asg${a.id === selected ? ' on' : ''}${picked ? ' multi' : ''}`}
            onClick={(e) => onSelect(a.id, e.ctrlKey || e.metaKey)}
            onContextMenu={(e) => { e.preventDefault(); onContext?.(a, e); }}
          >
            <span className="asg-name">{a.name}</span>
            <span className={`asg-due${soon ? ' soon' : ''}${late ? ' late' : ''}`} title={fmtDue(due)}>
              {late ? 'closed ' : 'due '}{relTime(due)}
            </span>
            <span className="asg-score">{a.score ?? '–'}/{a.total ?? '?'}</span>
            <span className="bar"><i style={{ width: `${pct}%` }} /></span>
          </button>
        );
      })}
    </div>
  );
}

export function ConnectPanel({ status, statusError, bridge, onRestart }: {
  status: Status | null; statusError: string | null; bridge: BridgeInfo | null; onRestart: () => void;
}) {
  const bridgeUp = !!status;
  return (
    <div className="connect">
      <h2>CONNECT<span className="blink">_</span></h2>
      <ol className="steps">
        <li className={bridgeUp ? 'ok' : 'todo'}>
          <b>Bridge</b> on 127.0.0.1:{bridge?.port ?? 8787}
          <span className="muted"> — {bridgeUp ? (bridge?.managed ? 'started by this app' : 'external process') : statusError ?? 'starting…'}</span>
          {bridge?.error && <div className="warn">{bridge.error}</div>}
        </li>
        <li className={status?.connected ? 'ok' : 'todo'}>
          <b>WebAssign tab</b> — install <code>webassign-mathpad.user.js</code> in Tampermonkey or Violentmonkey,
          then open <code>webassign.net</code> and log in. Keep the tab open.
        </li>
      </ol>
      <div className="connect-actions">
        <button type="button" className="btn" onClick={onRestart}>Restart bridge</button>
      </div>
      {bridge && bridge.log.length > 0 && <pre className="code-block log">{bridge.log.join('\n')}</pre>}
    </div>
  );
}

/** The app needs userscript 0.3.0+ (question HTML placeholders, grading marks). */
export const MIN_USERSCRIPT = '0.3.2';

export function scriptCurrent(v: string | null | undefined): boolean {
  if (!v) return false;
  const a = v.split('.').map(Number);
  const b = MIN_USERSCRIPT.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) > b[i];
  }
  return true;
}

export function StatusBar({ status, bridge, busyText, onHelp }: {
  status: Status | null; bridge: BridgeInfo | null; busyText: string | null; onHelp: () => void;
}) {
  const on = !!status?.connected;
  return (
    <footer className="statusbar">
      <span className={`dot${on ? ' on' : ''}`} />
      <span>{on ? 'LINKED' : status ? 'NO TAB' : 'BRIDGE DOWN'}</span>
      {status?.page && <span className="muted">{status.page}</span>}
      <span className="sep">│</span>
      <span className="muted">bridge {bridge?.managed ? 'managed' : status ? 'external' : 'offline'} :{bridge?.port ?? 8787}</span>
      {on && !scriptCurrent(status?.userscriptVersion) && (
        <><span className="sep">│</span><span className="warn" title="Reinstall webassign-mathpad.user.js in Tampermonkey">userscript outdated</span></>
      )}
      {busyText && (<><span className="sep">│</span><span className="busy">{busyText}<span className="blink">_</span></span></>)}
      <span className="spacer" />
      <button type="button" className="link" onClick={onHelp}>F1 keyboard</button>
    </footer>
  );
}

export type Toast = { id: number; kind: 'ok' | 'err' | 'info'; text: string };

export function Toasts({ items, onDismiss }: { items: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts">
      {items.map((t) => (
        <button type="button" key={t.id} className={`toast ${t.kind}`} onClick={() => onDismiss(t.id)}>{t.text}</button>
      ))}
    </div>
  );
}
