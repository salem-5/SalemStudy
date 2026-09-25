import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ScanText } from 'lucide-react';
import { useDiagramQuestion, type DiagramQuestion } from '../lib/diagramAsk';
import { whereLabel, type DiagramCandidate } from '../lib/diagrams';
import { KindIcon } from './Sources';

/** Asks which diagrams a quiz being written should label. Mounted once, in the shell. */
export function DiagramAsk() {
  const question = useDiagramQuestion();
  return question ? <DiagramAskDialog key={question.id} question={question} /> : null;
}

function DiagramAskDialog({ question }: { question: DiagramQuestion }) {
  const { candidates, notebook, answer } = question;
  const matching = candidates.filter((d) => d.matches);
  // The ones that match what the sources teach come first; the rest wait behind "Show all".
  const [all, setAll] = useState(!matching.length);
  const [ticked, setTicked] = useState(() => new Set(matching.map((d) => d.key)));
  const shown = all ? candidates : matching;
  const chosen = candidates.filter((d) => ticked.has(d.key));
  const bySource = [...new Map(shown.map((d) => [d.source.id, d.source])).values()];
  const toggle = (keys: string[], on: boolean) => setTicked((t) => {
    const n = new Set(t);
    keys.forEach((k) => (on ? n.add(k) : n.delete(k)));
    return n;
  });
  const shownOn = shown.filter((d) => ticked.has(d.key)).length;

  // No backdrop click or Escape: the quiz is waiting on this answer.
  return createPortal(
    <div className="modal-backdrop">
      <div className="modal wide diagram-ask" role="dialog" aria-modal="true" aria-labelledby="diagram-ask-title">
        <header>
          <span id="diagram-ask-title"><ScanText />Choose diagrams to label</span>
        </header>
        <div className="modal-body">
          <p className="diagram-ask-lead muted">
            For the quiz in <b>{notebook}</b>.{' '}
            {matching.length
              ? `${matching.length} of the ${candidates.length} diagrams found match what your sources teach.`
              : `None of the ${candidates.length} diagrams found clearly match what your sources teach, so they are all shown.`}
          </p>
          <div className="diagram-pick-head">
            <span className="pick-count">{chosen.length} chosen</span>
            {!!shown.length && (
              <button type="button" className="link" onClick={() => toggle(shown.map((d) => d.key), shownOn < shown.length)}>
                {shownOn < shown.length ? 'Select all' : 'Select none'}
              </button>
            )}
            {!!matching.length && matching.length < candidates.length && (
              <button type="button" className="btn small" onClick={() => setAll((v) => !v)}>
                {all ? 'Only the matching ones' : `Show all ${candidates.length}`}
              </button>
            )}
          </div>
          <div className="diagram-pick-list">
            {bySource.map((s) => (
              <div key={s.id} className="diagram-pick-source">
                <div className="diagram-pick-title"><KindIcon kind={s.kind} /><span>{s.title}</span></div>
                <div className="diagram-pick-grid">
                  {shown.filter((d) => d.source.id === s.id).map((d) => (
                    <DiagramTile key={d.key} d={d} on={ticked.has(d.key)} tagged={all && !d.matches && !!matching.length} onToggle={(on) => toggle([d.key], on)} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={() => answer([])}>Skip diagrams</button>
          <button type="button" className="btn primary" onClick={() => answer(chosen)} autoFocus>
            {chosen.length ? `Label ${chosen.length} diagram${chosen.length === 1 ? '' : 's'}` : 'Continue without diagrams'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function DiagramTile({ d, on, tagged, onToggle }: { d: DiagramCandidate; on: boolean; tagged: boolean; onToggle: (on: boolean) => void }) {
  const where = whereLabel(d.source, d.found.where);
  return (
    <button type="button" className={`diagram-pick-item${on ? ' on' : ''}`} aria-pressed={on}
      title={on ? 'Leave this diagram out' : 'Make a question from this diagram'} onClick={() => onToggle(!on)}>
      <span className="diagram-pick-img">
        <img src={d.image} alt={`Diagram on ${where.toLowerCase()}`} draggable={false} />
        {tagged && <span className="diagram-pick-tag" title="The AI did not match this one to what your sources teach">not matched</span>}
      </span>
      <span className="diagram-pick-cap">
        <span className="diagram-pick-box">{on && <Check />}</span>
        <span className="diagram-pick-where">{where}</span>
      </span>
    </button>
  );
}
