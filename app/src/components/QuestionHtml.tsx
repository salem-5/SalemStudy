import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Box, Draft } from '../types';
import { sanitizeQuestionHtml } from '../lib/sanitize';
import { adaptImagesIn } from '../lib/images';
import { Combo } from './Combo';
import { MathView } from './MathView';
import { focusBox } from './BoxCard';

type Slot = { el: HTMLElement; box: number; sub: number | null; kind: 'slot' | 'opt'; value: string | null };

type Props = {
  html: string;
  boxes: Box[];
  draftOf: (b: Box) => Draft;
  setDraft: (b: Box, d: Draft) => void;
};

/**
 * Renders WebAssign's own question markup and mounts live widgets where the
 * answer boxes were: inline dropdowns, text fields, radio/checkbox markers,
 * and a clickable preview for math boxes (edited in the card below).
 */
export function QuestionHtml({ html, boxes, draftOf, setDraft }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const clean = useMemo(() => sanitizeQuestionHtml(html), [html]);
  const [slots, setSlots] = useState<Slot[]>([]);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.innerHTML = clean;
    adaptImagesIn(root);
    setSlots(Array.from(root.querySelectorAll<HTMLElement>('.wa-slot, .wa-opt')).map((el) => ({
      el,
      box: Number(el.dataset.box),
      sub: el.dataset.sub !== undefined ? Number(el.dataset.sub) : null,
      kind: el.classList.contains('wa-opt') ? 'opt' : 'slot',
      value: el.dataset.value ?? null,
    })));
  }, [clean]);

  const isOn = (b: Box, v: string) => {
    const d = draftOf(b);
    return Array.isArray(d) ? d.includes(v) : d === v;
  };

  const choose = (b: Box, v: string) => {
    if (b.kind === 'checkboxes') {
      const cur = draftOf(b) as string[];
      setDraft(b, cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]);
    } else {
      setDraft(b, v);
    }
  };

  // Reflect selection and grading on the option labels WebAssign rendered.
  useEffect(() => {
    ref.current?.querySelectorAll<HTMLElement>('.wa-opt-label').forEach((l) => {
      const b = boxes[Number(l.dataset.box) - 1];
      if (!b) return;
      l.classList.toggle('on', isOn(b, l.dataset.value ?? ''));
      l.dataset.status = b.status;
    });
  });

  // Clicks on WebAssign's own label markup (plain DOM) arrive here; clicks on
  // the portaled markers are handled by their own onClick.
  const onClick = (e: React.MouseEvent) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('.wa-opt-label[data-box]');
    if (!t) return;
    const b = boxes[Number(t.dataset.box) - 1];
    if (b && t.dataset.value !== undefined) choose(b, t.dataset.value);
  };

  return (
    <>
      {/* .qContent matches the wrapper WebAssign's selectors expect. */}
      <div className="qhtml" onClick={onClick}>
        <div ref={ref} className="standard qContent container" />
      </div>
      {slots.map((s, i) => {
        const b = boxes[s.box - 1];
        if (!b) return null;
        return createPortal(<SlotWidget slot={s} box={b} draft={draftOf(b)} setDraft={(d) => setDraft(b, d)} on={s.value !== null && isOn(b, s.value)} onPick={() => s.value !== null && choose(b, s.value)} />, s.el, `${s.box}-${s.sub ?? ''}-${s.value ?? ''}-${i}`);
      })}
    </>
  );
}

function SlotWidget({ slot, box, draft, setDraft, on, onPick }: {
  slot: Slot; box: Box; draft: Draft; setDraft: (d: Draft) => void; on: boolean; onPick: () => void;
}) {
  if (slot.kind === 'opt') {
    return (
      <span
        role={box.kind === 'checkboxes' ? 'checkbox' : 'radio'}
        aria-checked={on}
        onClick={onPick}
        className={`opt-mark ${box.kind === 'checkboxes' ? 'check' : 'radio'}${on ? ' on' : ''} status-${box.status}`}
      />
    );
  }
  const tag = <sup className={`slot-tag status-${box.status}`}>{box.index}</sup>;

  if (box.kind === 'choice' && box.choices) {
    return <>{tag}<Combo inline choices={box.choices} value={String(draft)} onChange={setDraft} status={box.status} label={`answer ${box.index}`} /></>;
  }
  if (box.kind === 'multiselect' && box.choices) {
    const list = draft as string[];
    const k = slot.sub ?? 0;
    return (
      <Combo
        inline
        choices={box.choices}
        value={list[k] ?? ''}
        status={box.status}
        onChange={(v) => { const next = [...list]; next[k] = v; setDraft(next); }}
      />
    );
  }
  if (box.kind === 'text' || box.kind === 'unsupported') {
    return (
      <>
        {tag}
        <input
          className={`slot-input status-${box.status}`}
          size={Math.max(18, String(draft).length + 2)}
          style={{ minWidth: 130 }}
          spellCheck={false}
          value={String(draft)}
          aria-label={`answer ${box.index}`}
          onChange={(e) => setDraft(e.target.value)}
        />
      </>
    );
  }
  if (box.kind === 'essay') {
    return <button type="button" className={`slot-math status-${box.status}`} onClick={() => focusBox(box.index)}>{tag} essay ↓</button>;
  }
  // math: show the current draft, edit in the card below
  const draftStr = String(draft).trim();
  const serverMath = !!box.value && !/^<math[^>]*\/>$/.test(box.value.trim());
  return (
    <button type="button" className={`slot-math status-${box.status}`} onClick={() => focusBox(box.index)} title="Edit in the math editor below">
      {tag}
      {draftStr ? <MathView expr={String(draft)} /> : serverMath ? <MathView mathml={box.value} /> : <span className="slot-empty">enter math</span>}
    </button>
  );
}
