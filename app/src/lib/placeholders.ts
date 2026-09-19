import type { Box, Question } from '../types';
import { toText } from './mathpad.js';

// Userscripts before 0.3.0 send WebAssign's raw .qContent markup: real
// <select>/<input>/MathType widgets, grading badges and <script> blocks. This
// is the app-side twin of the userscript's questionHtml(): it swaps each answer
// widget for the placeholders QuestionHtml renders, so questions look right no
// matter which userscript version is installed.

const hasPlaceholders = (html: string) => /class="wa-(slot|opt|static)"/.test(html);
const clean = (s: string | null | undefined) => String(s ?? '').replace(/\s+/g, ' ').trim();
const isEmptyMathML = (v: string | undefined) => !v || /^<math[^>]*\/>$/.test(v.trim());
const isWellFormedMath = (value: string): boolean => {
  if (!value) return false;
  try {
    const d = new DOMParser().parseFromString(value, 'application/xml');
    return d.documentElement?.localName === 'math' && !d.querySelector('parsererror');
  } catch {
    return false;
  }
};

/**
 * Closed/answered math boxes render their answer into a `.wa-static` span. If a
 * box's own value came back empty (the input was gone) or malformed (WebAssign
 * stores some answers with unescaped `<`/`>`), copy the well-formed static
 * answer onto the box so the card below shows the same math as the question.
 *
 * Every math box produces exactly one placeholder in DOM order: a `wa-slot`
 * while editable, or a `wa-static` once closed. So the placeholders zip 1:1
 * onto the math boxes. `data-boxid` (userscript 0.3.4+) is used as well when
 * present, which also covers odd layouts.
 */
function fillStaticMath(q: Question): Question {
  if (!q.html) return q;
  const mathBoxes = q.boxes.filter((b) => b.kind === 'math');
  if (!mathBoxes.length || !mathBoxes.some((b) => isEmptyMathML(b.value) || !isWellFormedMath(b.value))) return q;
  const doc = new DOMParser().parseFromString(`<div>${q.html}</div>`, 'text/html');

  const readStatic = (el: HTMLElement): { value: string; text: string } => {
    const math = el.querySelector('math');
    if (math) {
      // XMLSerializer escapes < in attributes/text (outerHTML does not), so a
      // malformed server value becomes well-formed MathML here.
      const value = new XMLSerializer().serializeToString(math);
      if (isWellFormedMath(value)) {
        let text = '';
        try { text = toText(value); } catch { /* keep text blank */ }
        return { value, text };
      }
    }
    // MathJax output without a usable <math> element: keep the visible text.
    return { value: '', text: (el.textContent ?? '').trim() };
  };

  const answers = new Map<string, { value: string; text: string }>();

  const mathNodes = Array.from(doc.querySelectorAll<HTMLElement>('.wa-slot[data-box], .wa-static'))
    .filter((el) => el.classList.contains('wa-static') || q.boxes[Number(el.dataset.box) - 1]?.kind === 'math');
  if (mathNodes.length === mathBoxes.length) {
    mathBoxes.forEach((b, i) => {
      const el = mathNodes[i];
      if (el?.classList.contains('wa-static')) answers.set(b.id, readStatic(el));
    });
  }
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>('.wa-static[data-boxid]'))) {
    const id = el.dataset.boxid!;
    if (!answers.has(id)) answers.set(id, readStatic(el));
  }
  if (!answers.size) return q;

  let changed = false;
  const boxes = q.boxes.map((b) => {
    if (b.kind !== 'math') return b;
    // Keep values that are present and well-formed.
    if (!isEmptyMathML(b.value) && isWellFormedMath(b.value)) return b;
    const ex = answers.get(b.id);
    if (!ex || (!ex.value && !ex.text)) return b;
    changed = true;
    return ex.value ? { ...b, value: ex.value, text: ex.text || b.text } : { ...b, text: ex.text || b.text };
  });
  return changed ? { ...q, boxes } : q;
}

function convert(html: string, boxes: Box[], code: string | null): { html: string; display: Box['display'][] } {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html');
  const root = doc.getElementById('root')!;
  // Grading marks (.waMark) are left for sanitizeQuestionHtml, which reads the
  // grade of closed questions' choices from them.
  root.querySelectorAll('script, style, link, .js-question-resources, .extraContent, .badgeWrap, .tooltip, .latex-source, .mathtype-overlay-trigger, [class*="mathtype-overlay"]')
    .forEach((e) => e.remove());

  const slot = (n: number, sub?: number) => {
    const s = doc.createElement('span');
    s.className = 'wa-slot';
    s.dataset.box = String(n);
    if (sub !== undefined) s.dataset.sub = String(sub);
    return s;
  };

  const display = boxes.map((b) => {
    const n = b.index;
    const esc = CSS.escape(b.id);
    if (b.kind === 'math') {
      const ed = root.querySelector(`#editable-math-${esc}`);
      const wrap = ed && (ed.closest('.mathtype-wrapper') ?? ed);
      // Only a disabled editor or a .mtAnswer with real content is closed; an
      // empty .mtAnswer is a placeholder and the box must stay an editable slot.
      const ans = wrap?.querySelector('.mtAnswer');
      const hasAnswer = !!ans && (!!ans.querySelector('math') || (ans.textContent ?? '').trim() !== '');
      const closed = !!wrap && (!!ed?.classList.contains('mtDisabled') || hasAnswer);
      if (wrap && !closed) wrap.replaceWith(slot(n));
      return b.display ?? null;
    }
    const opts = Array.from(root.querySelectorAll<HTMLInputElement>(`input[name="${esc}"][type="radio"], input[name="${esc}"][type="checkbox"]`));
    if (opts.length) {
      opts.forEach((inp) => {
        const lbl = inp.id ? root.querySelector(`label[for="${CSS.escape(inp.id)}"]`) : null;
        if (lbl instanceof HTMLElement) {
          lbl.classList.add('wa-opt-label');
          lbl.dataset.box = String(n);
          lbl.dataset.value = inp.value;
          lbl.removeAttribute('for');
        }
        const o = doc.createElement('span');
        o.className = 'wa-opt';
        o.dataset.box = String(n);
        o.dataset.value = inp.value;
        inp.replaceWith(o);
      });
      return b.display ?? (opts[0].type === 'checkbox' ? 'checkbox' : 'radio');
    }
    const targets = Array.from(root.querySelectorAll(`select[name="${esc}"], textarea[name="${esc}"], input[name="${esc}"]:not([type="hidden"])`));
    const isSelect = targets.some((t) => t.tagName === 'SELECT');
    targets.forEach((t, j) => t.replaceWith(slot(n, targets.length > 1 ? j : undefined)));
    return b.display ?? (isSelect ? 'dropdown' : null);
  });

  // Remaining radios/checkboxes belong to closed questions; sanitizeQuestionHtml shows them read-only.
  root.querySelectorAll('input:not([type="radio"]):not([type="checkbox"]), select, textarea, button').forEach((e) => e.remove());
  if (code) {
    root.querySelectorAll('div').forEach((el) => {
      if (clean(el.textContent) === clean(code) && !el.querySelector('.wa-slot, .wa-opt')) el.remove();
    });
  }
  return { html: root.innerHTML, display };
}

/**
 * Unanswered MathType boxes sometimes arrive as an empty `.wa-static` (the
 * userscript sees an empty `.mtAnswer` and thinks the box is closed). Turn those
 * back into editable `wa-slot`s so they render as normal answer widgets.
 *
 * Every math box yields one placeholder in DOM order (slot or static), so the
 * placeholders zip 1:1 onto the math boxes.
 */
function fixEmptyMathStatics(q: Question): Question {
  if (!q.html) return q;
  const mathBoxes = q.boxes.filter((b) => b.kind === 'math');
  if (!mathBoxes.length) return q;
  const doc = new DOMParser().parseFromString(`<div>${q.html}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  if (!root) return q;
  const nodes = Array.from(root.querySelectorAll<HTMLElement>('.wa-slot[data-box], .wa-static'))
    .filter((el) => el.classList.contains('wa-static') || q.boxes[Number(el.dataset.box) - 1]?.kind === 'math');
  if (nodes.length !== mathBoxes.length) return q;

  let changed = false;
  mathBoxes.forEach((b, i) => {
    const el = nodes[i];
    if (!el?.classList.contains('wa-static') || b.status !== 'unanswered') return;
    const empty = !el.querySelector('math') && !(el.textContent ?? '').trim();
    if (!empty) return;
    const slot = doc.createElement('span');
    slot.className = 'wa-slot';
    slot.dataset.box = String(b.index);
    el.replaceWith(slot);
    changed = true;
  });
  return changed ? { ...q, html: root.innerHTML } : q;
}

/** Make a question from any userscript version render like one from the current version. */
export function normalizeQuestion(q: Question): Question {
  const filled = fillStaticMath(fixEmptyMathStatics(q));
  if (!filled.html || hasPlaceholders(filled.html) || !filled.boxes.length) {
    return { ...filled, boxes: filled.boxes.map((b) => ({ ...b, display: b.display ?? null })) };
  }
  const { html, display } = convert(filled.html, filled.boxes, filled.code);
  return { ...filled, html, boxes: filled.boxes.map((b, i) => ({ ...b, display: display[i] ?? null })) };
}
