import type { Box, BoxKind, Choice, Question } from '../types';
import { questionStatus } from './format';
import { sanitizeQuestionHtml } from './sanitize';
import { asMath, blank, escMath, escText, mathmlToLatex, texUnicode } from './tex';

export { mathmlToLatex };

// ---------------------------------------------------------------------------
// The export turns an assignment into a worksheet: the question exactly as
// WebAssign renders it (math, figures, sub-parts, option lists), every answer
// widget replaced by a named placeholder, an answer box per part to write in,
// and a compact mark scheme at the end.
// ---------------------------------------------------------------------------

export type ExportImage = { file: string; url: string; alt: string };
export type LatexExport = { tex: string; images: ExportImage[] };
export type ExportMeta = {
  course?: string; section?: string; term?: string; date?: Date;
  /** Title on the sheet and in the PDF metadata; the assignment name by default. */
  title?: string;
  /** Add a blank area under each question to work the answer out in. */
  workings?: boolean;
  /** Print the Name / Class / Date line (default on). */
  nameFields?: boolean;
  /** Embed the invisible plain-text transcript (default on). */
  transcript?: boolean;
};

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** A, B, … Z, AA, AB … — the "variable name" a placeholder and its box share. */
const letter = (i: number): string =>
  (i < 26 ? '' : LETTERS[Math.floor(i / 26) - 1]) + LETTERS[i % 26];

export const boxLabel = (index: number, sub: number | null = null) =>
  letter(index - 1) + (sub === null ? '' : String(sub + 1));

/** WebAssign figures, as opposed to watex glyphs and grading icons. */
export const isFigure = (url: string) =>
  /^https?:/i.test(url) && !/\/watex\/img\//i.test(url)
  && !/mathtype|overlay|mcorrect|mincorrect|mpartial/i.test(url);

// Only whitespace that HTML collapses; U+00A0 is spacing the question meant.
export const collapse = (s: string) => s.replace(/[ \t\r\n\f]+/g, ' ');

// ---------------------------------------------------------------------------
// Answer parts
// ---------------------------------------------------------------------------

export type Part = {
  label: string;
  kind: BoxKind | 'static';
  /** One answer box per sub-slot (a multiselect renders several dropdowns). */
  subs: number;
  marks: number | null;
  /** Listed above the box when the question itself does not print them. */
  options: string[] | null;
  /** The question already prints tick boxes for this part, so ticking is the answer. */
  inline: boolean;
  /** The answer, when WebAssign graded it correct. */
  answer: string | null;
};


// ---------------------------------------------------------------------------
// Question markup -> LaTeX
// ---------------------------------------------------------------------------

/** Per-question bookkeeping shared by the pre-pass and the renderer. */
export type Plan = {
  /** Display number of each option marker, restarting per choice group. */
  optNo: Map<Element, number>;
  /** Label for the n-th `.wa-static` in document order. */
  staticLabels: string[];
  /** Answer boxes a question without WebAssign boxes still needs. */
  synthetic: Part[];
  /** Sub-slot count per box index, for multiselect dropdowns. */
  subs: Map<number, number>;
  /** Boxes whose options the question itself prints as tick boxes. */
  inlineOpts: Set<number>;
  /** Label for a closed question's group of read-only options. */
  groupLabel: Map<Element, string>;
};

export type Ctx = {
  plan: Plan;
  boxes: Box[];
  imgRef: (url: string, alt: string) => string | null;
  seen: { statics: number };
  /** Depth of inline-block ancestors: their block children stay on the line. */
  inline: number;
};

const parse = (html: string): Element => {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html');
  return doc.getElementById('root')!;
};

const groupOf = (el: Element): Element =>
  el.closest('.multBox, .questionRadio, .wa1ans, ul, ol, table') ?? el.parentElement ?? el;

/**
 * Walk the markup once before rendering: number the option markers, decide
 * which box each static answer belongs to, and invent parts for closed
 * questions that come back without any boxes.
 */
export function planQuestion(root: Element, q: Question): Plan {
  const optNo = new Map<Element, number>();
  const counters = new Map<unknown, number>();
  const groups: Element[] = [];
  const inlineOpts = new Set<number>();
  const groupLabel = new Map<Element, string>();

  root.querySelectorAll('.wa-opt, .static-opt').forEach((el) => {
    const key = el.classList.contains('wa-opt') ? `box:${el.getAttribute('data-box')}` : groupOf(el);
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    optNo.set(el, n);
    if (typeof key === 'string') inlineOpts.add(Number(el.getAttribute('data-box')));
    if (n === 1 && key instanceof Element) groups.push(key);
  });

  const subs = new Map<number, number>();
  root.querySelectorAll<HTMLElement>('.wa-slot[data-box]').forEach((el) => {
    const n = Number(el.dataset.box);
    subs.set(n, (subs.get(n) ?? 0) + 1);
  });

  const statics = Array.from(root.querySelectorAll<HTMLElement>('.wa-static'));
  const staticLabels: string[] = [];
  const synthetic: Part[] = [];

  if (q.boxes.length) {
    // Statics stand in for math boxes, one each, in document order — the same
    // pairing lib/placeholders.ts uses to recover their values.
    const mathBoxes = q.boxes.filter((b) => b.kind === 'math');
    const slots = Array.from(root.querySelectorAll<HTMLElement>('.wa-slot[data-box], .wa-static'))
      .filter((el) => el.classList.contains('wa-static') || q.boxes[Number(el.dataset.box) - 1]?.kind === 'math');
    statics.forEach((el, i) => {
      const byId = el.dataset.boxid && q.boxes.find((b) => b.id === el.dataset.boxid);
      if (byId) { staticLabels[i] = boxLabel(byId.index); return; }
      const zip = slots.length === mathBoxes.length ? mathBoxes[slots.indexOf(el)] : undefined;
      staticLabels[i] = zip ? boxLabel(zip.index) : boxLabel(q.boxes.length + i + 1);
    });
  } else {
    // A closed question: every static answer and every group of read-only
    // options becomes a part of its own so the sheet can still be answered.
    const answers = staticAnswerTexts(statics);
    statics.forEach((_, i) => {
      staticLabels[i] = letter(i);
      synthetic.push({
        label: staticLabels[i], kind: 'static', subs: 1, marks: null, options: null, inline: false,
        answer: answers[i] ?? null,
      });
    });
    groups.forEach((g, i) => {
      const label = letter(statics.length + i);
      groupLabel.set(g, label);
      const chosen = Array.from(g.querySelectorAll('.static-opt.on')).map((m) => optNo.get(m)).filter(Boolean);
      synthetic.push({
        label, kind: 'choice', subs: 1, marks: null, options: null, inline: true,
        answer: chosen.length ? chosen.map((n) => `option ${n}`).join(', ') : null,
      });
    });
  }

  return { optNo, staticLabels, synthetic, subs, inlineOpts, groupLabel };
}

/** The rendered answers inside `.wa-static` spans, in document order. */
export function staticAnswerTexts(statics: Element[]): (string | null)[] {
  return statics.map((el) => {
    const math = el.querySelector('math');
    if (math) {
      const tex = mathmlToLatex(new XMLSerializer().serializeToString(math));
      if (tex) return `$${tex}$`;
    }
    const t = collapse(el.textContent ?? '').trim();
    return t ? escText(t) : null;
  });
}

const CLASS_RULES: [string, (el: Element, ctx: Ctx) => string][] = [
  ['wa-slot', (el) => {
    const box = Number((el as HTMLElement).dataset.box);
    const sub = (el as HTMLElement).dataset.sub;
    return `\\wavar{${boxLabel(box, sub === undefined ? null : Number(sub))}}`;
  }],
  ['wa-opt', (el, ctx) => {
    const box = ctx.boxes[Number(el.getAttribute('data-box')) - 1];
    return `${optMark(box?.kind === 'checkboxes' || box?.display === 'checkbox')}{${ctx.plan.optNo.get(el) ?? 1}}`;
  }],
  // A closed question keeps the original input's type on the marker.
  ['static-opt', (el, ctx) => `${optMark(el.classList.contains('checkbox'))}{${ctx.plan.optNo.get(el) ?? 1}}`],
  ['wa-static', (_el, ctx) => `\\wavar{${ctx.plan.staticLabels[ctx.seen.statics++] ?? '?'}}`],
  ['wa-tex', (el) => {
    const src = texUnicode((el.textContent ?? '').trim());
    if (!src) return '';
    return (el as HTMLElement).dataset.display ? `\\[${src}\\]` : `$${src}$`;
  }],
  ['wx-sqrt', (el, ctx) => {
    const body = el.querySelector('.wx-radicand');
    return `$\\sqrt{${asMath(body ? kids(body, ctx) : '')}}$`;
  }],
  ['wx-overarrow', (el, ctx) => `$\\vec{${asMath(kids(el, ctx))}}$`],
  ['wx-delim', (el) => escText((el.textContent ?? '').trim())],
  ['multBox', (el, ctx) => optionGroup(el, ctx)],
  ['questionRadio', (el, ctx) => optionGroup(el, ctx)],
  ['stackblock', (el, ctx) => stack(el, ctx)],
  ['subblock', (el, ctx) => {
    const label = collapse(el.querySelector('.sublabel')?.textContent ?? '').trim();
    const body = el.querySelector('.subpart');
    const inner = body ? kids(body, ctx) : kids(el, ctx);
    return `\n\\begin{wapart}{${escText(label || '')}}\n${inner}\n\\end{wapart}\n`;
  }],
  ['wa1given', (el, ctx) => `\n\\begin{waindent}\n${kids(el, ctx)}\n\\end{waindent}\n`],
  ['watexcenter', (el, ctx) => `\n{\\centering ${kids(el, ctx)}\\par}\n`],
  ['nobr', (el, ctx) => {
    const body = kids(el, ctx);
    return /\\\\|\n\n|\\begin/.test(body) ? body : `\\mbox{${body}}`;
  }],
];

const BLOCK = new Set(['p', 'div', 'section', 'article', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'center', 'figure', 'figcaption', 'dl', 'dt', 'dd']);
// Spans WebAssign lays out as blocks (one choice per line, one line per step).
const BLOCK_CLASS = ['ms', 'wa1par', 'wa1ans', 'wa1given', 'fitb', 'figure', 'multBox', 'watexline'];
const SKIP = new Set(['script', 'style', 'noscript', 'select', 'input', 'textarea', 'button', 'option']);

/**
 * WebAssign lays a formula out as inline-block boxes, each holding a block
 * `div`. The browser keeps them side by side on one line, so a block child of
 * an inline-block must not become a paragraph of its own.
 */
const isInlineBox = (el: Element): boolean =>
  el.classList.contains('watexinlineblock')
  || /display\s*:\s*inline(-block|-table|-flex)?\b/i.test(el.getAttribute('style') ?? '');

const kids = (el: Element, ctx: Ctx): string =>
  Array.from(el.childNodes).map((c) => node(c, ctx)).join('');

/** Bold/italic markup around one letter is a variable, so typeset it as math. */
const styled = (body: string, cmd: 'mathbf' | 'mathit', text: 'textbf' | 'textit'): string => {
  const m = /^\s*([A-Za-z])\s*$/.exec(body);
  if (m) return `$\\${cmd}{${m[1]}}$`;
  // WebAssign nests its style spans; one variable is enough.
  if (/^\s*\$\\math(it|bf|rm)\{[A-Za-z]\}\$\s*$/.test(body)) return body.trim();
  return blank(body) ? body : `\\${text}{${body}}`;
};

const isBold = (el: Element) =>
  el.localName === 'b' || el.localName === 'strong'
  || /font-weight:\s*(bold|[6-9]00)/i.test(el.getAttribute('style') ?? '');

const isItalic = (el: Element) =>
  el.localName === 'i' || el.localName === 'em' || el.localName === 'var'
  || /font-style:\s*italic/i.test(el.getAttribute('style') ?? '');

function node(n: Node, ctx: Ctx): string {
  if (n.nodeType === 3) return escText(collapse(n.nodeValue ?? ''));
  if (n.nodeType !== 1) return '';
  const el = n as Element;
  const tag = el.localName;
  if (SKIP.has(tag)) return '';

  for (const [cls, fn] of CLASS_RULES) {
    if (el.classList.contains(cls)) return fn(el, ctx);
  }

  if (tag === 'math') {
    const tex = mathmlToLatex(new XMLSerializer().serializeToString(el));
    return tex ? `$${tex}$` : '';
  }
  if (tag === 'img') return image(el, ctx);
  if (tag === 'br') return '\\\\\n';
  if (tag === 'hr') return '\n\\par\\noindent\\textcolor{waline}{\\rule{\\linewidth}{0.4pt}}\\par\n';
  if (tag === 'sub') return `$_{${asMath(kids(el, ctx))}}$`;
  if (tag === 'sup') return `$^{${asMath(kids(el, ctx))}}$`;
  if (tag === 'u' || tag === 'ins') return `\\underline{${kids(el, ctx)}}`;
  if (tag === 'table') return table(el, ctx);
  if (tag === 'ul' || tag === 'ol') return list(el, ctx, tag === 'ol');
  if (tag === 'li') return `\\item ${kids(el, ctx)}\n`;
  if (tag === 'figcaption' || el.classList.contains('alt-cap') || el.classList.contains('cap-btm-rit')) {
    const body = kids(el, ctx);
    return blank(body) ? '' : `\n{\\footnotesize\\color{wamuted}${body}\\par}\n`;
  }

  const inline = isInlineBox(el);
  const body = inline ? kids(el, { ...ctx, inline: ctx.inline + 1 }) : kids(el, ctx);
  if (isBold(el)) return styled(body, 'mathbf', 'textbf');
  if (isItalic(el)) return styled(body, 'mathit', 'textit');
  const block = BLOCK.has(tag) || BLOCK_CLASS.some((c) => el.classList.contains(c));
  if (block && !inline && !ctx.inline) return `\n${body}\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

/**
 * The app shows figures at their natural pixel size in a 13px/1.2-zoom column,
 * so a pixel is 0.85pt next to 11pt type. Fixed CSS sizes are converted the
 * same way; everything else keeps the image's own size (\wafig scales it).
 */
const PX_TO_PT = 0.85;

export function cssSize(el: Element): { w?: number; h?: number } {
  const style = el.getAttribute('style') ?? '';
  const read = (prop: string): number | undefined => {
    const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([\\d.]+)\\s*(px|pt|em|%)`, 'i').exec(style);
    if (!m) {
      const attr = Number(el.getAttribute(prop));
      return attr > 0 ? attr : undefined;
    }
    const n = Number(m[1]);
    if (m[2] === 'px') return n;
    if (m[2] === 'pt') return n * (96 / 72);
    if (m[2] === 'em') return n * 13;
    return undefined; // percentages depend on the column, not the image
  };
  return { w: read('width'), h: read('height') };
}

function image(el: Element, ctx: Ctx): string {
  const file = ctx.imgRef(el.getAttribute('src') ?? '', collapse(el.getAttribute('alt') ?? '').trim());
  if (!file) return '';
  const { w, h } = cssSize(el);
  const pt = (n: number) => `${(n * PX_TO_PT).toFixed(1)}pt`;
  const g = w ? `\\wafigw{${pt(w)}}{${file}}`
    : h ? `\\wafigh{${pt(h)}}{${file}}`
      : `\\wafig{${file}}`;
  // An image inside an option is part of that choice, not a figure of its own.
  return el.closest('.wa-opt-label, label') ? `${g}\\quad ` : `\\wafigblock{${g}}`;
}

// ---------------------------------------------------------------------------
// Tables and stacked equations
// ---------------------------------------------------------------------------

const rowsOf = (el: Element): Element[] =>
  Array.from(el.querySelectorAll(':scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr'));

/** Cell text cannot contain row breaks or paragraphs. */
const cell = (s: string) => s.replace(/\\\\\n?/g, ' ').replace(/\n{2,}/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * WebAssign draws a fraction as a little table — numerator row, a rule row,
 * denominator row — which flattens into nonsense ("y + 3 2") unless it is put
 * back together as a real fraction.
 */
function watexFraction(el: Element, ctx: Ctx): string | null {
  const build = (num: Element, den: Element) =>
    `$\\frac{${asMath(cell(kids(num, ctx)))}}{${asMath(cell(kids(den, ctx)))}}$`;

  const named = (part: string) => el.querySelector(`[class*="${part}"]`);
  const num = named('numer') ?? named('Numer');
  const den = named('denom') ?? named('denum') ?? named('Denom');
  if (num && den) return build(num, den);

  const rows = rowsOf(el);
  if (rows.length < 2 || rows.length > 3 || rows.some((r) => r.children.length !== 1)) return null;
  const cells = rows.map((r) => r.children[0]);
  const bar = (c: Element) => !collapse(c.textContent ?? '').trim() && !c.querySelector('.wa-slot, .wa-static, math');
  // Three rows: the middle one draws the bar. Two rows: a cell border does.
  if (rows.length === 3 && !bar(cells[1])) return null;
  if (rows.length === 2 && !/frac/i.test(el.className)) return null;
  if (bar(cells[0]) || bar(cells[cells.length - 1])) return null;
  return build(cells[0], cells[cells.length - 1]);
}

/** The column alignment WebAssign gives a watexarray cell. */
const cellAlign = (c: Element | undefined): string =>
  c?.classList.contains('watexright') ? 'r'
    : c?.classList.contains('watexcenter') ? 'c' : 'l';

function table(el: Element, ctx: Ctx): string {
  // watex builds layout out of tables. A fraction is put back together as
  // \frac; an aligned array is a real grid, so keep its cells and alignment.
  // Anything else is layout and its cells are already glyphs and spans.
  if (/watex/.test(el.className)) {
    const frac = watexFraction(el, ctx);
    if (frac) return frac;
    if (!el.classList.contains('watexarray')) return kids(el, ctx);
  }
  const rows = rowsOf(el);
  if (!rows.length) return kids(el, ctx);
  const cols = Math.max(1, ...rows.map((r) => r.children.length));
  const body = rows
    .map((r) => Array.from(r.children).map((c) => cell(kids(c, ctx))).join(' & '))
    .filter((r) => r.replace(/[&\s]/g, ''))
    .join(' \\\\\n');
  if (!body) return '';
  const ruled = /border/i.test(el.getAttribute('style') ?? '') || el.hasAttribute('border');
  const array = el.classList.contains('watexarray');
  const spec = ruled ? `|${'l|'.repeat(cols)}`
    : array ? `@{}${Array.from({ length: cols }, (_, i) => cellAlign(rows[0]?.children[i])).join('')}@{}`
      : `@{}${'l@{\\hspace{1.4em}}'.repeat(cols - 1)}l@{}`;
  // A bordered table gets a rule under every row, the way the browser draws it.
  const grid = ruled ? body.replace(/ \\\\\n/g, ' \\\\\n\\hline\n') : body;
  return `\n\\par\\noindent{\\renewcommand{\\arraystretch}{1.3}%
\\begin{tabular}{${spec}}\n${ruled ? '\\hline\n' : ''}${grid}${ruled ? ' \\\\\n\\hline' : ''}\n\\end{tabular}}\\par\n`;
}

/** A square when several options can be chosen, a circle when only one can. */
const optMark = (many: boolean | undefined) => (many ? '\\waopts' : '\\waoptc');

/** Roughly how wide a rendered option is, ignoring TeX markup. */
const visualLen = (s: string) => s.replace(/\\[a-zA-Z]+\*?|[{}$~\\]/g, '').trim().length;

/**
 * Lay a choice list out as a grid: short options share a line, long ones and
 * picture choices get one each. A loose run of tick boxes down the page reads
 * badly and wastes half the sheet.
 */
/** Lay rendered options out in as many columns as they comfortably fit. */
function optionGrid(cells: string[]): string {
  const rich = cells.some((c) => /\\wafig|\\begin\{/.test(c));
  const widest = Math.max(...cells.map(visualLen));
  const cols = rich || widest > 32 ? 1 : Math.min(widest > 15 ? 2 : 3, cells.length);
  const w = cols === 1 ? '\\linewidth' : `\\dimexpr(\\linewidth-${(cols - 1) * 12}pt)/${cols}\\relax`;

  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += cols) {
    const row = cells.slice(i, i + cols);
    while (row.length < cols) row.push('');
    rows.push(row.join(' & '));
  }
  // `[t]`: the first row's baseline lines up with the letter and the marks.
  return `{\\renewcommand{\\arraystretch}{1.5}%
\\begin{tabular}[t]{@{}${`p{${w}}`.repeat(cols)}@{}}
${rows.join(' \\\\\n')}
\\end{tabular}}`;
}

function optionGroup(el: Element, ctx: Ctx): string {
  const items = Array.from(el.children)
    .filter((c) => c.classList.contains('wa-opt') || c.querySelector('.wa-opt, .static-opt'));
  const cells = items.map((i) => cell(kids(i, ctx))).filter(Boolean);
  if (cells.length < 2) return kids(el, ctx);
  const grid = optionGrid(cells);
  // Ticking one of these boxes is the answer, so the part's letter belongs
  // here rather than over an empty box further down the page.
  const label = optionLabel(el, ctx);
  return label
    ? `\n\\waoptset{${label}}{}{${grid}}\n`
    : `\n\\par\\vspace{0.2em}\\noindent${grid}\\par\\vspace{0.25em}\n`;
}

/** The answer letter a group of inline options belongs to. */
function optionLabel(el: Element, ctx: Ctx): string | null {
  const opt = el.querySelector('.wa-opt[data-box]');
  if (opt) return boxLabel(Number(opt.getAttribute('data-box')));
  const stat = el.querySelector('.static-opt');
  return stat ? ctx.plan.groupLabel.get(groupOf(stat)) ?? null : null;
}

/**
 * `.stackblock` is WebAssign's equation layout: one row per line, with the
 * expression, the relation and the answer in their own cells. Keep the
 * alignment — that is what makes a list of answers readable.
 */
function stack(el: Element, ctx: Ctx): string {
  const lines = Array.from(el.querySelectorAll(':scope > .stackline, :scope > * > .stackline'));
  if (!lines.length) return kids(el, ctx);
  const pick = (row: Element, cls: string) => {
    const c = row.querySelector(`:scope > .${cls}`);
    return c ? cell(kids(c, ctx)) : '';
  };
  const body = lines.map((row) => {
    const text = pick(row, 'stacktext');
    const math = pick(row, 'stackmath');
    const op = pick(row, 'stackop');
    const ans = pick(row, 'stackans');
    const lead = [text, math].filter(Boolean).join(' ');
    return `${lead} & ${op} & ${ans}`;
  }).join(' \\\\\n');
  return `\n\\par\\noindent\\begin{tabular}{@{}r@{\\hspace{0.5em}}c@{\\hspace{0.5em}}l@{}}\n${body}\n\\end{tabular}\\par\n`;
}

function list(el: Element, ctx: Ctx, ordered: boolean): string {
  const env = ordered ? 'enumerate' : 'itemize';
  const items = Array.from(el.children).filter((c) => c.localName === 'li');
  if (!items.length) return kids(el, ctx);
  const body = items.map((li) => `\\item ${cell(kids(li, ctx))}`).join('\n');
  return `\n\\begin{${env}}[leftmargin=1.6em,itemsep=0.15em,topsep=0.25em]\n${body}\n\\end{${env}}\n`;
}

// ---------------------------------------------------------------------------
// Question body
// ---------------------------------------------------------------------------

/**
 * WebAssign wraps every symbol in its own span, so a formula arrives as a run
 * of one-token math islands. Fuse the neighbours back into one formula: TeX
 * then spaces the operators like the browser's math layout does.
 */
function joinMath(s: string): string {
  // Digits, operators and brackets between two formulas belong to the formula;
  // a sentence break (". ") or any word does not.
  // `\$` is a printed dollar sign, never a formula delimiter.
  const D = String.raw`(?<!\\)\$`;
  const GAP = new RegExp(`${D}([^$\\n]+)${D}([ \\t0-9.,;:+\\-=/*<>()[\\]|]*)${D}([^$\\n]+)${D}`, 'g');
  let out = s;
  for (let i = 0; i < 8; i++) {
    const next = out.replace(GAP, (m, a: string, gap: string, b: string) =>
      (/\.\s/.test(gap) ? m : `$${a} ${gap.trim()} ${b}$`));
    if (next === out) break;
    out = next;
  }
  // A number or bracket written right against a formula is part of it
  // ("30" + "^\circ", "(" + "a \cdot b"), and so is one that follows a
  // dangling operator ("z -" + " 4"), which would otherwise be set as a
  // trailing sign with no space after it.
  return out
    .replace(new RegExp(`(^|[^\\\\\\w])([0-9]+(?:\\.[0-9]+)?|[([])${D}([^$\\n]+)${D}`, 'g'), '$1$$$2 $3$$')
    .replace(new RegExp(`${D}([^$\\n]+)${D}([0-9]+(?:\\.[0-9]+)?)`, 'g'), '$$$1 $2$$')
    .replace(new RegExp(`${D}([^$\\n]*[-+*/=<>])${D} ?([0-9]+(?:\\.[0-9]+)?)`, 'g'), '$$$1 $2$$');
}

/**
 * A `\\` where a paragraph ends is a LaTeX error ("there's no line here to
 * end"), and blank lines inside a group are just noise; tidy both away.
 */
function cleanBody(s: string): string {
  return joinMath(s)
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(^|\n)[ \t]*\\\\[ \t]*(?=\n|$)/g, '$1')
    .replace(/\\\\\s*(?=\\end\{|\\par\b)/g, '')
    .replace(/(\\begin\{[a-z]+\}(?:\{[^}]*\})?)\s*\\\\/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The plain-text question, used when no markup came through. */
export function textBody(q: Question): string {
  return q.text
    .replace(/Press Space or Enter to edit this math answer\.?/gi, '')
    .split(/(\[\d+\]|\[image: [^\]]+\])/g)
    .map((p) => {
      const box = /^\[(\d+)\]$/.exec(p);
      if (box) return `\\wavar{${boxLabel(Number(box[1]))}}`;
      if (/^\[image:/.test(p)) return '\\textit{[figure]}';
      return escText(p);
    })
    .join('')
    .replace(/\n/g, '\n\n');
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

const choiceLabel = (b: Box, v: string) => b.choices?.find((c) => c.value === v)?.label ?? v;

/** An option label, with its own markup when it carries math or a figure. */
export function optionText(c: Choice, ctx: Ctx): string {
  if (c.html && /<(img|math|table|span|sub|sup)/i.test(c.html)) {
    const body = cleanBody(kids(parse(sanitizeQuestionHtml(c.html)), ctx));
    if (!blank(body)) return body.replace(/\n+/g, ' ');
  }
  return escText(c.label);
}

export function boxAnswer(b: Box): string | null {
  switch (b.kind) {
    case 'math': {
      const tex = mathmlToLatex(b.value);
      if (tex) return `$${tex}$`;
      return b.text ? `$${escMath(b.text)}$` : null;
    }
    case 'choice':
      return b.value ? escText(choiceLabel(b, b.value)) : null;
    case 'checkboxes': case 'multiselect':
      return b.value
        ? b.value.split(',').filter(Boolean).map((v) => escText(choiceLabel(b, v))).join(', ')
        : null;
    default:
      return b.value ? escText(b.value) : null;
  }
}


/** Past assignments arrive without boxes, so fall back to the score. */
export function isCorrect(q: Question): boolean {
  if (q.boxes.length) return questionStatus(q) === 'correct';
  return q.score != null && q.total != null && q.total > 0 && q.score >= q.total;
}

export function partsOf(q: Question, plan: Plan, ctx: Ctx): Part[] {
  if (!q.boxes.length) {
    const parts = plan.synthetic.map((p, _i, all) => ({
      ...p,
      // Without boxes there is no per-part score; a lone part carries them all.
      marks: all.length === 1 ? q.total : p.marks,
      answer: isCorrect(q) ? p.answer : null,
    }));
    return parts.length
      ? parts
      : [{ label: 'A', kind: 'static', subs: 1, marks: q.total, options: null, inline: false, answer: null }];
  }
  return q.boxes.map((b) => {
    // Options the question prints itself as tick boxes are answered there.
    const inline = plan.inlineOpts.has(b.index);
    const listed = !!b.choices && !inline && (b.kind === 'choice' || b.kind === 'checkboxes' || b.kind === 'multiselect');
    return {
      label: boxLabel(b.index),
      kind: b.kind,
      subs: b.kind === 'multiselect' ? Math.max(1, plan.subs.get(b.index) ?? 1) : 1,
      marks: b.part.total,
      options: listed ? b.choices!.map((c) => optionText(c, ctx)) : null,
      inline,
      answer: b.status === 'correct' ? boxAnswer(b) : null,
    };
  });
}
