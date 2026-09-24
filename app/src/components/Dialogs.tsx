import { useEffect, useRef } from 'react';
import { POPOVER_OPEN } from './Select';
import { X } from 'lucide-react';
import type { Box, Draft, DryRun, Question } from '../types';
import { MathView } from './MathView';
import { Attempts } from './BoxCard';
import { matchesServer } from '../lib/drafts';
import { SNIPPETS } from './MathEditor';

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.documentElement.hasAttribute(POPOVER_OPEN)) { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div ref={ref} tabIndex={-1} className={`modal${wide ? ' wide' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
        <header><span>{title}</span><button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><X /></button></header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

function DraftPreview({ box, draft }: { box: Box; draft: Draft }) {
  if (box.kind === 'math') return <MathView expr={String(draft)} />;
  const label = (v: string) => box.choices?.find((c) => c.value === v)?.label ?? v;
  if (Array.isArray(draft)) return <span>{draft.filter(Boolean).map(label).join(', ') || '∅'}</span>;
  return <span>{box.choices ? label(draft) || '∅' : draft || '∅'}</span>;
}

export function SubmitDialog({ question, draftOf, onConfirm, onClose }: {
  question: Question;
  draftOf: (b: Box) => Draft;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onConfirm(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onConfirm]);

  return (
    <Modal title={`SUBMIT Q${question.number}`} onClose={onClose}>
      <p className="muted">Each part below uses one attempt. Enter to submit, Esc to cancel.</p>
      <table className="confirm-table">
        <tbody>
          {question.boxes.map((b) => {
            const d = draftOf(b);
            const changed = !matchesServer(b, d);
            const used = b.part.submissions ?? 0;
            return (
              <tr key={b.id}>
                <td className="mono">[{b.index}]</td>
                <td className="answer"><DraftPreview box={b} draft={d} /></td>
                <td>{changed ? <span className="badge save unsaved">EDITED</span> : <span className="badge save saved">SAVED</span>}</td>
                <td>
                  <Attempts used={used} max={b.part.maxSubmissions} />
                  {b.part.maxSubmissions != null && <span className="muted"> → {Math.min(used + 1, b.part.maxSubmissions)}/{b.part.maxSubmissions}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose}>Cancel <kbd>Esc</kbd></button>
        <button type="button" className="btn primary" onClick={onConfirm}>Submit <kbd>↵</kbd></button>
      </div>
    </Modal>
  );
}

export function DryRunDialog({ dry, onClose }: { dry: DryRun; onClose: () => void }) {
  return (
    <Modal title="DRY RUN - nothing was sent" onClose={onClose} wide>
      <div className="mono muted">POST {dry.url}</div>
      <pre className="code-block">{JSON.stringify(dry.data, null, 2)}</pre>
    </Modal>
  );
}

const GLOBAL_KEYS: [string, string][] = [
  ['Ctrl+S', 'Save question (no submission used)'],
  ['Ctrl+Enter', 'Submit question'],
  ['Alt+← / Alt+→', 'Previous / next question'],
  ['Alt+↑ / Alt+↓', 'Previous / next answer box'],
  ['Enter', 'Next answer box'],
  ['Ctrl+R', 'Reload assignment from WebAssign'],
  ['F1', 'This help'],
];

const EDITOR_KEYS: [string, string][] = [
  ['Tab / Enter', 'Accept suggestion'],
  ['Ctrl+Space', 'Suggestions, or history when empty'],
  ['Ctrl+M', 'Show the MathML sent'],
  ['( [ {', 'Auto-close; ) or ] types over, so (1, 2] works'],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="KEYBOARD" onClose={onClose} wide>
      <div className="keys-grid">
        <div>
          <h4>GLOBAL</h4>
          {GLOBAL_KEYS.map(([k, v]) => <div key={k} className="keyrow"><kbd>{k}</kbd><span>{v}</span></div>)}
          <h4>MATH EDITOR</h4>
          {EDITOR_KEYS.map(([k, v]) => <div key={k} className="keyrow"><kbd>{k}</kbd><span>{v}</span></div>)}
        </div>
        <div>
          <h4>TEMPLATES (wrap the selection)</h4>
          {SNIPPETS.filter((s) => s.keys).map((s) => (
            <div key={s.id} className="keyrow"><kbd>{s.keys}</kbd><span>{s.title} <span className="muted">{s.label}</span></span></div>
          ))}
          <h4>SYNTAX</h4>
          <div className="syntax">
            {['1/(2x)', 'x^(n+1)', 'x_1', 'sqrt(x)', 'root(3, x)', 'sin^2(x)', 'log_2(8)', '|x - 1|', '<1, -2, 3>', '(0, inf]', 'vec(v)', '2#i - #j', 'theta', 'DNE'].map((s) => (
              <div key={s} className="keyrow"><code>{s}</code><MathView expr={s} /></div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
