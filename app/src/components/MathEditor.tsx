import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  CONST_WORDS, GREEK_LOWER, GREEK_UPPER, HASH, LOGS, SPECIAL_FUNCS, TRIG, TRIG_ALIAS,
} from '../lib/mathpad.js';
import { previewExpr } from '../lib/render';
import { loadHistory } from '../lib/drafts';
import { MathView } from './MathView';

// ---------------------------------------------------------------------------
// Templates. "§" is replaced by the selection, "‸" marks where the caret lands.
// ---------------------------------------------------------------------------

type Snippet = { id: string; label: string; title: string; keys?: string; none: string; sel?: string };

export const SNIPPETS: Snippet[] = [
  { id: 'frac', label: 'a⁄b', title: 'Fraction', keys: 'Ctrl+/', none: '(‸)/()', sel: '(§)/(‸)' },
  { id: 'sup', label: 'xⁿ', title: 'Power', keys: 'Ctrl+↑', none: '^(‸)', sel: '(§)^(‸)' },
  { id: 'sub', label: 'xₙ', title: 'Subscript', keys: 'Ctrl+↓', none: '_(‸)', sel: '(§)_(‸)' },
  { id: 'sqrt', label: '√x', title: 'Square root', keys: 'Alt+R', none: 'sqrt(‸)', sel: 'sqrt(§)‸' },
  { id: 'root', label: 'ⁿ√x', title: 'nth root', keys: 'Alt+Shift+R', none: 'root(‸, )', sel: 'root(‸, §)' },
  { id: 'abs', label: '|x|', title: 'Absolute value', keys: 'Alt+A', none: '|‸|', sel: '|§|‸' },
  { id: 'paren', label: '( )', title: 'Parentheses', keys: 'Alt+9', none: '(‸)', sel: '(§)‸' },
  { id: 'vector', label: '⟨ ⟩', title: 'Angle brackets (vector)', keys: 'Alt+V', none: '<‸>', sel: '<§>‸' },
  { id: 'ival1', label: '( ]', title: 'Interval (a, b]', none: '(‸]', sel: '(§]‸' },
  { id: 'ival2', label: '[ )', title: 'Interval [a, b)', none: '[‸)', sel: '[§)‸' },
  { id: 'vec', label: 'v⇀', title: 'Vector accent', keys: 'Alt+Shift+V', none: 'vec(‸)', sel: 'vec(§)‸' },
  { id: 'exp', label: 'eˣ', title: 'Exponential', keys: 'Alt+E', none: 'e^(‸)', sel: 'e^(§)‸' },
  { id: 'ln', label: 'ln', title: 'Natural log', keys: 'Alt+L', none: 'ln(‸)', sel: 'ln(§)‸' },
  { id: 'logb', label: 'logₙ', title: 'Log base n', none: 'log_(‸)()', sel: 'log_(‸)(§)' },
  { id: 'dot', label: '⋅', title: 'Multiply / dot', keys: 'Alt+.', none: ' * ‸' },
  { id: 'pi', label: 'π', title: 'Pi', keys: 'Alt+P', none: 'pi‸' },
  { id: 'inf', label: '∞', title: 'Infinity', keys: 'Alt+I', none: 'inf‸' },
  { id: 'theta', label: 'θ', title: 'Theta', keys: 'Alt+T', none: 'theta‸' },
  { id: 'le', label: '≤', title: 'Less or equal', none: ' <= ‸' },
  { id: 'ge', label: '≥', title: 'Greater or equal', none: ' >= ‸' },
  { id: 'ne', label: '≠', title: 'Not equal', none: ' != ‸' },
  { id: 'ijk', label: 'î ĵ k̂', title: 'Unit vectors', none: '#i‸' },
  { id: 'dne', label: 'DNE', title: 'Does not exist', none: 'DNE‸' },
];

const BY_KEYS = new Map(SNIPPETS.filter((s) => s.keys).map((s) => [s.keys!, s]));

function comboOf(e: React.KeyboardEvent): string {
  const arrows: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
  let k = arrows[e.key] ?? e.key;
  // With Alt/Shift, e.key may be a shifted symbol; fall back to the physical key.
  if (e.altKey && /^Key[A-Z]$/.test(e.code)) k = e.code.slice(3);
  if (e.altKey && /^Digit\d$/.test(e.code)) k = e.code.slice(5);
  if (e.altKey && e.code === 'Period') k = '.';
  if (k.length === 1) k = k.toUpperCase();
  return `${e.ctrlKey || e.metaKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${k}`;
}

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------

type Suggestion = { word: string; insert: string; caret: number; kind: string; sample: string };

const fn = (w: string, kind = 'function'): Suggestion => ({
  word: w, insert: `${w}()`, caret: w.length + 1, kind, sample: `${w}(x)`,
});

const SUGGESTIONS: Suggestion[] = [
  ...TRIG.map((w) => fn(w, 'trig')),
  ...Object.keys(TRIG_ALIAS).map((w) => ({ ...fn(w, 'trig'), sample: `${w}(x)` })),
  ...LOGS.map((w) => fn(w, 'log')),
  { word: 'logb', insert: 'log_()()', caret: 5, kind: 'log', sample: 'log_b(x)' },
  ...SPECIAL_FUNCS.filter((w) => w !== 'root').map((w) => fn(w)),
  { word: 'root', insert: 'root(, )', caret: 5, kind: 'function', sample: 'root(n, x)' },
  ...Object.keys(GREEK_LOWER).map((w) => ({ word: w, insert: w, caret: w.length, kind: 'greek', sample: w })),
  ...Object.keys(GREEK_UPPER).map((w) => ({ word: w, insert: w, caret: w.length, kind: 'Greek', sample: w })),
  ...Object.keys(CONST_WORDS).map((w) => ({ word: w, insert: w, caret: w.length, kind: 'constant', sample: w })),
  ...['union', 'intersect'].map((w) => ({ word: w, insert: ` ${w} `, caret: w.length + 2, kind: 'set', sample: `A ${w} B` })),
  ...Object.keys(HASH).map((w) => ({ word: `#${w}`, insert: `#${w}`, caret: w.length + 1, kind: 'symbol', sample: `#${w}` })),
];

function suggestFor(prefix: string): Suggestion[] {
  const p = prefix.toLowerCase();
  const exact = SUGGESTIONS.filter((s) => s.word === prefix);
  const rest = SUGGESTIONS.filter((s) => s.word !== prefix && s.word.toLowerCase().startsWith(p));
  return [...exact, ...rest].slice(0, 9);
}

// ---------------------------------------------------------------------------

export type MathEditorHandle = { focus: () => void };

type Props = {
  value: string;
  onChange: (v: string) => void;
  onEnter?: () => void;
  placeholder?: string;
};

type Popup = { items: Suggestion[]; history: string[]; active: number; from: number } | null;

export const MathEditor = forwardRef<MathEditorHandle, Props>(function MathEditor(
  { value, onChange, onEnter, placeholder },
  ref,
) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const [popup, setPopup] = useState<Popup>(null);
  const [showSource, setShowSource] = useState(false);
  const preview = useMemo(() => previewExpr(value), [value]);

  useImperativeHandle(ref, () => ({ focus: () => ta.current?.focus() }), []);

  const commit = (next: string, caret: number) => {
    onChange(next);
    requestAnimationFrame(() => {
      const el = ta.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
      autoSize(el);
    });
  };

  const insertTemplate = (s: Snippet) => {
    const el = ta.current;
    if (!el) return;
    const a = el.selectionStart;
    const b = el.selectionEnd;
    const selected = value.slice(a, b);
    let t = selected && s.sel ? s.sel.replace('§', selected) : s.none;
    const caretAt = t.indexOf('‸');
    t = t.replace('‸', '');
    commit(value.slice(0, a) + t + value.slice(b), a + (caretAt < 0 ? t.length : caretAt));
    setPopup(null);
  };

  const refreshPopup = (text: string, caret: number, force = false) => {
    const m = /(#?[A-Za-z]+)$/.exec(text.slice(0, caret));
    if (m && (m[1].length >= 2 || m[1].startsWith('#'))) {
      const items = suggestFor(m[1]);
      if (items.length) {
        setPopup({ items, history: [], active: 0, from: caret - m[1].length });
        return;
      }
    }
    if (force) {
      const history = loadHistory().slice(0, 9);
      setPopup(history.length ? { items: [], history, active: 0, from: caret } : null);
      return;
    }
    setPopup(null);
  };

  const accept = (i: number) => {
    const el = ta.current;
    if (!popup || !el) return;
    const caret = el.selectionStart;
    if (popup.history.length) {
      commit(popup.history[i], popup.history[i].length);
    } else {
      const s = popup.items[i];
      commit(value.slice(0, popup.from) + s.insert + value.slice(caret), popup.from + s.caret);
    }
    setPopup(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const count = popup ? (popup.history.length || popup.items.length) : 0;

    if (popup && count) {
      if (e.key === 'ArrowDown' && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setPopup({ ...popup, active: (popup.active + 1) % count });
        return;
      }
      if (e.key === 'ArrowUp' && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setPopup({ ...popup, active: (popup.active - 1 + count) % count });
        return;
      }
      if ((e.key === 'Tab' || e.key === 'Enter') && !e.ctrlKey) {
        e.preventDefault();
        accept(popup.active);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setPopup(null);
        return;
      }
    }

    if (e.key === ' ' && e.ctrlKey) {
      e.preventDefault();
      refreshPopup(value, el.selectionStart, true);
      return;
    }
    if (e.key.toLowerCase() === 'm' && e.ctrlKey && !e.altKey) {
      e.preventDefault();
      setShowSource((v) => !v);
      return;
    }

    const snip = BY_KEYS.get(comboOf(e));
    if (snip) {
      e.preventDefault();
      e.stopPropagation();
      insertTemplate(snip);
      return;
    }

    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      onEnter?.();
      return;
    }

    const a = el.selectionStart;
    const b = el.selectionEnd;
    const next = value[a];
    const prev = value[a - 1];
    const closers: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

    // Smart brackets: wrap selections, auto-close, and let ")" or "]" type over
    // an auto-inserted closer so half-open intervals like (1, 2] still work.
    if (closers[e.key] && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const inner = value.slice(a, b);
      commit(value.slice(0, a) + e.key + inner + closers[e.key] + value.slice(b), inner ? a + inner.length + 2 : a + 1);
      return;
    }
    if ((e.key === ')' || e.key === ']') && a === b && (next === ')' || next === ']')) {
      e.preventDefault();
      commit(value.slice(0, a) + e.key + value.slice(a + 1), a + 1);
      return;
    }
    if (e.key === '}' && a === b && next === '}') {
      e.preventDefault();
      commit(value, a + 1);
      return;
    }
    if (e.key === 'Backspace' && a === b && prev && next
        && ((prev === '(' && (next === ')' || next === ']')) || (prev === '[' && (next === ']' || next === ')')) || (prev === '{' && next === '}'))) {
      e.preventDefault();
      commit(value.slice(0, a - 1) + value.slice(a + 1), a - 1);
    }
  };

  return (
    <div className={`mathed${preview.error ? ' has-error' : ''}`}>
      <div className="mathed-row">
        <span className="mathed-prompt" aria-hidden>ƒ›</span>
        <div className="mathed-input">
          <textarea
            ref={ta}
            rows={1}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            value={value}
            placeholder={placeholder ?? 'type math… (Ctrl+Space for suggestions)'}
            onChange={(e) => {
              onChange(e.target.value);
              autoSize(e.target);
              refreshPopup(e.target.value, e.target.selectionStart);
            }}
            onKeyDown={onKeyDown}
            onBlur={() => setTimeout(() => setPopup(null), 120)}
          />
          {popup && (
            <ul className="suggest" role="listbox">
              {popup.history.length > 0 && <li className="suggest-head">history</li>}
              {popup.history.map((h, i) => (
                <li key={h} className={i === popup.active ? 'active' : ''} onMouseDown={(ev) => { ev.preventDefault(); accept(i); }}>
                  <span className="suggest-word">{h}</span>
                  <MathView className="suggest-math" expr={h} />
                </li>
              ))}
              {popup.items.map((s, i) => (
                <li key={s.word} className={i === popup.active ? 'active' : ''} onMouseDown={(ev) => { ev.preventDefault(); accept(i); }}>
                  <span className="suggest-word">{s.word}</span>
                  <MathView className="suggest-math" expr={s.sample} />
                  <span className="suggest-kind">{s.kind}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          type="button"
          className={`icon-btn${showSource ? ' on' : ''}`}
          title="Show MathML sent to WebAssign (Ctrl+M)"
          onClick={() => setShowSource((v) => !v)}
        >
          {'</>'}
        </button>
      </div>

      <div className="mathed-preview">
        {preview.error
          ? <span className="mathed-error">⚠ {preview.error}</span>
          : preview.html
            ? <span className="math" dangerouslySetInnerHTML={{ __html: preview.html }} />
            : <span className="muted">preview</span>}
      </div>

      {showSource && <pre className="mathed-source">{preview.mathml}</pre>}

      <div className="palette">
        {SNIPPETS.map((s) => (
          <button
            type="button"
            key={s.id}
            title={`${s.title}${s.keys ? `  ·  ${s.keys}` : ''}`}
            onMouseDown={(e) => { e.preventDefault(); insertTemplate(s); }}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
});

function autoSize(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}
