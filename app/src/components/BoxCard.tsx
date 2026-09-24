import { useLayoutEffect, useRef } from 'react';
import type { Box, Choice, Draft } from '../types';
import { adaptImagesIn } from '../lib/images';
import { MathEditor } from './MathEditor';
import { MathView } from './MathView';
import { STATUS_LABEL, attemptsLeft } from '../lib/format';
import { isEmptyDraft, matchesServer } from '../lib/drafts';
import { sanitizeQuestionHtml } from '../lib/sanitize';
import { Combo } from './Combo';

type Props = {
  box: Box;
  draft: Draft;
  onChange: (d: Draft) => void;
  onNext: () => void;
};

export function focusBox(index: number) {
  const el = document.querySelector<HTMLElement>(
    `#box-${index} textarea, #box-${index} input, #box-${index} select, #box-${index} [data-focus]`,
  );
  el?.focus();
  el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

export function Attempts({ used, max }: { used: number | null; max: number | null }) {
  if (max == null) return null;
  const u = used ?? 0;
  return (
    <span className={`attempts${u >= max ? ' spent' : ''}`} title={`${u} of ${max} submissions used`}>
      <span className="pips">
        {Array.from({ length: max }, (_, i) => <i key={i} className={i < u ? 'used' : ''} />)}
      </span>
      {u}/{max}
    </span>
  );
}

export function BoxCard({ box, draft, onChange, onNext }: Props) {
  const saved = matchesServer(box, draft);
  const empty = isEmptyDraft(draft);
  const left = attemptsLeft(box);
  const saveState = !saved ? 'unsaved' : empty ? 'empty' : 'saved';
  const saveTitle = {
    unsaved: 'Your edit is only local. Save (Ctrl+S) or submit to send it to WebAssign.',
    saved: 'This is exactly what WebAssign has saved for this box.',
    empty: 'Nothing saved for this box yet.',
  }[saveState];

  return (
    <section id={`box-${box.index}`} className={`box status-${box.status} save-${saveState}`}>
      <header className="box-head">
        <span className="box-index">[{box.index}]</span>
        <span className="box-kind">{box.kind === 'math' ? 'MATH' : box.typeName.toUpperCase()}</span>
        <span className="spacer" />
        <span className={`badge save ${saveState}`} title={saveTitle}>
          {saveState === 'unsaved' ? '● UNSAVED' : saveState === 'saved' ? '✓ SAVED' : '○ EMPTY'}
        </span>
        <span
          className={`badge grade ${box.status}`}
          title={box.mark?.title ?? 'Grade of the last submission for this part'}
        >
          {box.status === 'correct' ? '✓ ' : box.status === 'incorrect' ? '✗ ' : ''}
          {STATUS_LABEL[box.status]}
        </span>
        {box.part.total != null && (
          <span className="points">{box.part.score ?? '–'}/{box.part.total} pt</span>
        )}
        <Attempts used={box.part.submissions} max={box.part.maxSubmissions} />
      </header>

      <div className="box-body">
        {box.kind === 'math' && (
          <>
            {!String(draft).trim() && !!box.value && !/^<math[^>]*\/>$/.test(box.value.trim()) && (
              <div className="box-server-math" title="Saved answer on WebAssign">
                <MathView mathml={box.value} />
              </div>
            )}
            <MathEditor value={String(draft)} onChange={onChange} onEnter={onNext} />
          </>
        )}
        {box.kind === 'choice' && box.choices && box.display === 'dropdown' && (
          <Combo choices={box.choices} value={String(draft)} onChange={onChange} status={box.status} label={`answer ${box.index}`} />
        )}
        {box.kind === 'choice' && box.choices && box.display !== 'dropdown' && (
          <ChoiceEditor choices={box.choices} value={String(draft)} onChange={onChange} />
        )}
        {box.kind === 'checkboxes' && box.choices && (
          <ChecksEditor choices={box.choices} value={draft as string[]} onChange={onChange} />
        )}
        {box.kind === 'multiselect' && box.choices && (
          <div className="multiselect">
            {(draft as string[]).map((v, i) => (
              <Combo
                key={i}
                choices={box.choices!}
                value={v}
                onChange={(nv) => onChange((draft as string[]).map((x, j) => (j === i ? nv : x)))}
              />
            ))}
          </div>
        )}
        {(box.kind === 'text' || box.kind === 'unsupported') && (
          <input
            className="text-input"
            spellCheck={false}
            value={String(draft)}
            placeholder={box.kind === 'unsupported' ? 'raw response string (advanced)' : 'answer'}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.ctrlKey) { e.preventDefault(); onNext(); } }}
          />
        )}
        {box.kind === 'essay' && (
          <textarea className="text-input essay" value={String(draft)} onChange={(e) => onChange(e.target.value)} />
        )}
      </div>

      <footer className="box-foot">
        {box.hint && <span className="hint">{box.hint}</span>}
        {box.kind === 'unsupported' && <span className="warn">This {box.typeName} box needs the WebAssign page for real editing.</span>}
        {box.kind === 'math' && !saved && box.value && !/^<math[^>]*\/>$/.test(box.value) && (
          <span className="server-value">server has <MathView mathml={box.value} /></span>
        )}
        {box.mark?.title && box.status !== 'unanswered' && <span className="mark-msg">{box.mark.title}</span>}
        {left === 0 && <span className="warn">No submissions left for this part.</span>}
      </footer>
    </section>
  );
}

function OptionBody({ c }: { c: Choice }) {
  const rich = !!c.html && /<(img|math|table|span)/i.test(c.html);
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => { if (rich) adaptImagesIn(ref.current); }, [rich, c.html]);
  if (rich) {
    return <span ref={ref} className="opt-html" dangerouslySetInnerHTML={{ __html: sanitizeQuestionHtml(c.html!) }} />;
  }
  return <>{c.label}</>;
}

function ChoiceEditor({ choices, value, onChange }: { choices: Choice[]; value: string; onChange: (v: string) => void }) {
  const idx = choices.findIndex((c) => c.value === value);
  return (
    <div
      className="choices"
      role="radiogroup"
      tabIndex={0}
      data-focus
      onKeyDown={(e) => {
        const n = Number(e.key);
        if (n >= 1 && n <= choices.length) { e.preventDefault(); onChange(choices[n - 1].value); }
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); onChange(choices[(idx + 1) % choices.length].value); }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); onChange(choices[(idx - 1 + choices.length) % choices.length].value); }
        if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); onChange(''); }
      }}
    >
      {choices.map((c, i) => (
        <button
          type="button"
          tabIndex={-1}
          key={c.value}
          role="radio"
          aria-checked={c.value === value}
          className={c.value === value ? 'on' : ''}
          onClick={() => onChange(c.value === value ? '' : c.value)}
        >
          <kbd>{i + 1}</kbd><OptionBody c={c} />
        </button>
      ))}
    </div>
  );
}

function ChecksEditor({ choices, value, onChange }: { choices: Choice[]; value: string[]; onChange: (v: string[]) => void }) {
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div
      className="choices checks"
      tabIndex={0}
      data-focus
      onKeyDown={(e) => {
        const n = Number(e.key);
        if (n >= 1 && n <= choices.length) { e.preventDefault(); toggle(choices[n - 1].value); }
      }}
    >
      {choices.map((c, i) => (
        <button type="button" tabIndex={-1} key={c.value} className={value.includes(c.value) ? 'on' : ''} onClick={() => toggle(c.value)}>
          <kbd>{i + 1}</kbd><OptionBody c={c} />
        </button>
      ))}
    </div>
  );
}
