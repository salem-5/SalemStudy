import type { Box, Question } from '../types';

// Userscripts before 0.3.0 send WebAssign's raw .qContent markup: real
// <select>/<input>/MathType widgets, grading badges and <script> blocks. This
// is the app-side twin of the userscript's questionHtml(): it swaps each answer
// widget for the placeholders QuestionHtml renders, so questions look right no
// matter which userscript version is installed.

const hasPlaceholders = (html: string) => /class="wa-(slot|opt|static)"/.test(html);
const clean = (s: string | null | undefined) => String(s ?? '').replace(/\s+/g, ' ').trim();

function convert(html: string, boxes: Box[], code: string | null): { html: string; display: Box['display'][] } {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html');
  const root = doc.getElementById('root')!;
  // Grading marks (.waMark) are left for sanitizeQuestionHtml, which reads the
  // grade of closed questions' choices from them.
  root.querySelectorAll('script, style, link, .js-question-resources, .extraContent, .badgeWrap, .tooltip, .latex-source')
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
      // Closed boxes render their answer in .mtAnswer; leave them for sanitizeQuestionHtml.
      if (wrap && !wrap.querySelector('.mtAnswer')) wrap.replaceWith(slot(n));
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

/** Make a question from any userscript version render like one from the current version. */
export function normalizeQuestion(q: Question): Question {
  if (!q.html || hasPlaceholders(q.html) || !q.boxes.length) {
    return { ...q, boxes: q.boxes.map((b) => ({ ...b, display: b.display ?? null })) };
  }
  const { html, display } = convert(q.html, q.boxes, q.code);
  return { ...q, html, boxes: q.boxes.map((b, i) => ({ ...b, display: display[i] ?? null })) };
}
