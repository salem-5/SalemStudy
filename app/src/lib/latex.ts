import type { Assignment, Box, BoxKind, Choice, Question } from '../types';
import { questionStatus } from './format';
import { sanitizeQuestionHtml } from './sanitize';
import { mathValueText } from './render';
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

const boxLabel = (index: number, sub: number | null = null) =>
  letter(index - 1) + (sub === null ? '' : String(sub + 1));

/** WebAssign figures, as opposed to watex glyphs and grading icons. */
const isFigure = (url: string) =>
  /^https?:/i.test(url) && !/\/watex\/img\//i.test(url)
  && !/mathtype|overlay|mcorrect|mincorrect|mpartial/i.test(url);

// Only whitespace that HTML collapses; U+00A0 is spacing the question meant.
const collapse = (s: string) => s.replace(/[ \t\r\n\f]+/g, ' ');

// ---------------------------------------------------------------------------
// Answer parts
// ---------------------------------------------------------------------------

type Part = {
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

/** How tall the box to write in should be, by what is being asked for. */
const BOX_HEIGHT: Record<string, string> = {
  math: '2.6em', text: '2.1em', unsupported: '2.1em', choice: '1.9em',
  checkboxes: '1.9em', multiselect: '1.9em', static: '2.4em', essay: '0em',
};

// ---------------------------------------------------------------------------
// Question markup -> LaTeX
// ---------------------------------------------------------------------------

/** Per-question bookkeeping shared by the pre-pass and the renderer. */
type Plan = {
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

type Ctx = {
  plan: Plan;
  boxes: Box[];
  imgRef: (url: string, alt: string) => string | null;
  seen: { statics: number };
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
function planQuestion(root: Element, q: Question): Plan {
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
function staticAnswerTexts(statics: Element[]): (string | null)[] {
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

  const body = kids(el, ctx);
  if (isBold(el)) return styled(body, 'mathbf', 'textbf');
  if (isItalic(el)) return styled(body, 'mathit', 'textit');
  if (BLOCK.has(tag) || BLOCK_CLASS.some((c) => el.classList.contains(c))) return `\n${body}\n`;
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

function cssSize(el: Element): { w?: number; h?: number } {
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

function table(el: Element, ctx: Ctx): string {
  // watex builds layout out of tables; most are already glyphs and spans.
  if (/watex/.test(el.className)) return watexFraction(el, ctx) ?? kids(el, ctx);
  const rows = rowsOf(el);
  if (!rows.length) return kids(el, ctx);
  const cols = Math.max(1, ...rows.map((r) => r.children.length));
  const body = rows
    .map((r) => Array.from(r.children).map((c) => cell(kids(c, ctx))).join(' & '))
    .filter((r) => r.replace(/[&\s]/g, ''))
    .join(' \\\\\n');
  if (!body) return '';
  const ruled = /border/i.test(el.getAttribute('style') ?? '') || el.hasAttribute('border');
  const spec = ruled ? `|${'l|'.repeat(cols)}` : `@{}${'l@{\\hspace{1.4em}}'.repeat(cols - 1)}l@{}`;
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
function textBody(q: Question): string {
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
function optionText(c: Choice, ctx: Ctx): string {
  if (c.html && /<(img|math|table|span|sub|sup)/i.test(c.html)) {
    const body = cleanBody(kids(parse(sanitizeQuestionHtml(c.html)), ctx));
    if (!blank(body)) return body.replace(/\n+/g, ' ');
  }
  return escText(c.label);
}

function boxAnswer(b: Box): string | null {
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

function plainAnswer(b: Box): string {
  switch (b.kind) {
    case 'math': return mathValueText(b.value) || b.text || '';
    case 'choice': return b.value ? choiceLabel(b, b.value) : '';
    case 'checkboxes': case 'multiselect':
      return b.value ? b.value.split(',').filter(Boolean).map((v) => choiceLabel(b, v)).join(', ') : '';
    default: return b.value;
  }
}

/** Past assignments arrive without boxes, so fall back to the score. */
function isCorrect(q: Question): boolean {
  if (q.boxes.length) return questionStatus(q) === 'correct';
  return q.score != null && q.total != null && q.total > 0 && q.score >= q.total;
}

function partsOf(q: Question, plan: Plan, ctx: Ctx): Part[] {
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

/** A rough height in cm for a rendered question body — figures dominate it. */
function bodyHeight(tex: string): number {
  let cm = 0;
  for (const m of tex.matchAll(/\\wafig(w|h)?\{([0-9.]+)pt\}/g)) {
    // Height is known outright; a width only bounds it, so guess a square-ish
    // figure. A figure with neither prints at its own size, around 5cm.
    cm += m[1] === 'h' ? Number(m[2]) / 28.45 + 0.8 : 4.5;
  }
  cm += (tex.match(/\\wafig\{/g)?.length ?? 0) * 5;
  const words = tex.replace(/\\[a-zA-Z]+\*?|[{}$&\\]/g, ' ').replace(/\s+/g, ' ').trim();
  return cm + Math.ceil(words.length / 90) * 0.55;
}

/**
 * Roughly how tall everything below a question's first line is, in cm: the
 * working box, then one entry per answer. A question that does not fit in what
 * is left of the page starts on the next one instead of being split.
 * Capped, so a genuinely long question can still break somewhere.
 */
function needSpace(parts: Part[], workings: boolean, body: string): string {
  let cm = 1.5 + bodyHeight(body); // heading and rule, then the question itself
  if (workings) cm += Number.parseFloat(workingHeight(parts)) + 1.1;
  for (const p of parts) {
    if (p.inline) cm += 0.7;
    else if (p.options?.length) cm += p.subs * (0.6 + 0.75 * Math.ceil(p.options.length / 3));
    else if (p.kind === 'essay') cm += 4.2;
    else cm += p.subs * 1.3;
  }
  return `${Math.min(cm, 11).toFixed(1)}cm`;
}

/** Room to work in, sized by how much the question asks for. */
const WORK_CM: Record<string, number> = {
  essay: 3, math: 1.5, static: 1.5, text: 1.2, unsupported: 1.2,
  choice: 0.4, checkboxes: 0.4, multiselect: 0.4,
};

const workingHeight = (parts: Part[]) => {
  const need = parts.reduce((n, p) => n + (WORK_CM[p.kind] ?? 1.2) * p.subs, 2);
  return `${Math.max(3, Math.min(9, need)).toFixed(1)}cm`;
};

/** The answer area: one labelled box per part, IGCSE style. */
function answerArea(parts: Part[]): string {
  // Nothing to write down: every part is ticked in the question itself.
  if (parts.every((p) => p.inline)) return '';
  const out = ['\\waanshead'];
  for (const p of parts) {
    const marks = p.marks != null ? `[${p.marks}]` : '';
    if (p.inline) {
      out.push(`\\waansnote{${p.label}}{ticked in the question above}{${marks}}`);
      continue;
    }
    // A part chosen from a list is answered by ticking one of the choices,
    // not by copying the wording into a box.
    if (p.options?.length) {
      const mark = optMark(p.kind === 'checkboxes');
      const grid = optionGrid(p.options.map((o, i) => `${mark}{${i + 1}}${o}`));
      for (let i = 0; i < p.subs; i++) {
        const label = p.subs > 1 ? `${p.label}${i + 1}` : p.label;
        out.push(`\\waoptset{${label}}{${i === 0 ? marks : ''}}{${grid}}`);
      }
      continue;
    }
    if (p.kind === 'essay') {
      out.push(`\\waansrule{${p.label}}{${marks}}`);
      out.push(Array(5).fill('\\waansline').join('\n'));
      continue;
    }
    const height = BOX_HEIGHT[p.kind] ?? '2.1em';
    for (let i = 0; i < p.subs; i++) {
      const label = p.subs > 1 ? `${p.label}${i + 1}` : p.label;
      out.push(`\\waansbox{${label}}{${height}}{${i === 0 ? marks : ''}}`);
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Mark scheme
// ---------------------------------------------------------------------------

function markScheme(rows: { q: number; parts: Part[] }[]): string {
  const any = rows.some((r) => r.parts.some((p) => p.answer));
  const width = '\\dimexpr\\linewidth-0.9cm-1.1cm-1.3cm-6\\tabcolsep\\relax';
  const body = rows.map(({ q, parts }, i) => parts.map((p, j) => {
    const answer = p.answer ?? '\\textcolor{wamuted}{--}';
    const marks = p.marks != null ? String(p.marks) : '';
    return `${j === 0 ? `\\textbf{${q}}` : ''} & \\textcolor{waaccent}{\\textbf{${p.label}}} & ${answer} & ${marks} \\\\${j === parts.length - 1 && i < rows.length - 1 ? '\n\\wasep' : ''}`;
  }).join('\n')).join('\n');

  // `\color` in a `>{}` column spec drops that column's first baseline, so
  // every cell carries its own formatting instead.
  return `\\section*{\\color{waaccent}Mark scheme}
{\\small\\setlength{\\tabcolsep}{4pt}\\renewcommand{\\arraystretch}{1.3}
\\begin{longtable}{@{}p{0.9cm}p{1.1cm}p{${width}}>{\\raggedleft\\arraybackslash}p{1.3cm}@{}}
\\hline
\\rule{0pt}{2.6ex}\\textbf{Q} & \\textbf{Part} & \\textbf{Answer} & \\textbf{Marks} \\\\[1pt]
\\hline
\\endhead
${body}
\\hline
\\end{longtable}}

{\\footnotesize\\color{wamuted}${any
    ? 'Only answers WebAssign graded correct are listed; a dash means the part was not answered correctly yet.'
    : 'No graded answers yet, so every part is blank.'}\\par}`;
}

// ---------------------------------------------------------------------------
// Machine-readable transcript
// ---------------------------------------------------------------------------

const NOISE = /Press Space or Enter to edit this math answer\.?/gi;

/** What a box is asking for, in words. */
const KIND_WORD: Record<string, string> = {
  math: 'a mathematical expression', text: 'a short typed answer', essay: 'a written answer',
  choice: 'one option', checkboxes: 'any number of options', multiselect: 'one option per dropdown',
  unsupported: 'a typed answer', static: 'an answer',
};

/**
 * A plain-text copy of the question, printed invisibly and taking no space, so
 * that reading software (and anything that extracts the PDF's text) gets the
 * words, the maths and a description of every figure rather than page images.
 */
function transcript(q: Question, figures: ExportImage[]): string {
  const lines: string[] = [
    `Question ${q.number}${q.code ? ` (${q.code})` : ''}${q.total != null ? `, ${q.total} mark${q.total === 1 ? '' : 's'}` : ''}.`,
    q.text.replace(NOISE, '').replace(/\[(\d+)\]/g, (_m, n: string) => `[answer ${boxLabel(Number(n))}]`).trim(),
  ];
  figures.forEach((f, i) => {
    lines.push(`Figure ${i + 1} (${f.file}): ${f.alt || 'a figure from this question; no description was provided.'}`);
  });
  for (const b of q.boxes) {
    const what = KIND_WORD[b.kind] ?? 'an answer';
    const options = b.choices?.length ? ` Options: ${b.choices.map((c, i) => `${i + 1}. ${c.label}`).join('; ')}.` : '';
    const value = plainAnswer(b).trim();
    const answer = b.status === 'correct' && value ? ` Correct answer: ${value}.` : '';
    lines.push(`Answer ${boxLabel(b.index)} expects ${what}.${options}${answer}`);
  }
  return `\\watext{${lines.filter(Boolean).map((l) => escText(collapse(l).trim())).join('\\par ')}}`;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

const PREAMBLE = String.raw`\usepackage[margin=1.9cm,headheight=15pt,headsep=11pt,footskip=22pt]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{lmodern}
\usepackage[T1]{fontenc}
\usepackage{microtype}
\usepackage{enumitem}
\usepackage{array}
\usepackage{longtable}
\usepackage{graphicx}
\usepackage{xcolor}
\usepackage{parskip}
\usepackage{fancyhdr}
\usepackage[hidelinks]{hyperref}

\definecolor{waaccent}{HTML}{1B4F9C}
\definecolor{wamuted}{HTML}{6E7787}
\definecolor{waline}{HTML}{C3CDDC}
\definecolor{watint}{HTML}{EDF2FA}
\definecolor{wamark}{HTML}{7C8AA0}

\setlength{\parindent}{0pt}
\setlength{\emergencystretch}{3em}
\raggedbottom
\renewcommand{\arraystretch}{1.15}

% Figures: natural size scaled to the app's, never wider than the column.
\newsavebox{\wabox}
\newcommand{\waclamp}[1]{\sbox{\wabox}{#1}%
  \ifdim\wd\wabox>\linewidth\resizebox{\linewidth}{!}{\usebox{\wabox}}\else\usebox{\wabox}\fi}
\newcommand{\wafig}[1]{\waclamp{\includegraphics[scale=0.85]{#1}}}
\newcommand{\wafigw}[2]{\waclamp{\includegraphics[width=#1]{#2}}}
\newcommand{\wafigh}[2]{\waclamp{\includegraphics[height=#1]{#2}}}
\newcommand{\wafigblock}[1]{\par\vspace{0.55em}{\centering#1\par}\vspace{0.55em}}

% An answer placeholder inside the question, named like the box below it.
\newcommand{\wavar}[1]{\,\fcolorbox{waline}{watint}{\rule[-0.3em]{0pt}{1.15em}\small\bfseries\color{waaccent}#1}\,}
% Options to mark: a circle when the question takes one answer, a square when
% it takes any number of them. The two glyphs are drawn at different sizes by
% the fonts, so the square is scaled up to match the circle.
\newcommand{\waoptmark}[2]{\raisebox{-0.16em}{\textcolor{wamark}{\large$#1$}}%
  \kern0.45em\textbf{\color{waaccent}#2.}\kern0.35em}
\newcommand{\waoptc}[1]{\waoptmark{\bigcirc}{#1}}
\newcommand{\waopts}[1]{\waoptmark{\scalebox{1.35}{$\square$}}{#1}}

% Keep a heading with what follows it.
\newcommand{\waneed}[1]{\par\penalty-150\vspace{0pt plus #1}\penalty-150\vspace{0pt plus -#1}}

% #4 is how much room the whole question wants, so it is not started near the
% bottom of a page and then broken before its working box.
\newcommand{\waqhead}[4]{%
  \waneed{#4}%
  \par\vspace{1.1em}%
  \noindent\textcolor{waaccent}{\rule{\linewidth}{1pt}}\par\vspace{0.35em}%
  \noindent{\large\bfseries\color{waaccent}#1}\hfill{\small\color{wamuted}#2}\hspace{0.7em}{\small\bfseries#3}%
  \par\nobreak\vspace{0.4em}}

\newenvironment{wapart}[1]{%
  \par\vspace{0.2em}%
  \begin{list}{}{%
    \setlength{\leftmargin}{2.3em}\setlength{\labelwidth}{1.9em}\setlength{\labelsep}{0.4em}%
    \setlength{\itemindent}{0pt}\setlength{\listparindent}{0pt}%
    \setlength{\topsep}{0.15em}\setlength{\parsep}{0.35em}\setlength{\itemsep}{0pt}}%
  \item[\textbf{#1}]}{\end{list}}

\newenvironment{waindent}{%
  \par\begin{list}{}{%
    \setlength{\leftmargin}{2.5em}\setlength{\rightmargin}{0pt}%
    \setlength{\topsep}{0.2em}\setlength{\parsep}{0.3em}\setlength{\itemsep}{0pt}}%
  \item[]}{\end{list}}

\newcommand{\waanshead}{\par\vspace{0.8em}\nobreak\noindent
  {\footnotesize\bfseries\color{waaccent}ANSWER}\hspace{0.6em}{\color{waline}\hrulefill}\par\nobreak\vspace{0.25em}}
\newcommand{\waanshint}[1]{\par\nobreak\vspace{0.1em}\noindent\hspace*{1.7em}%
  \parbox{\dimexpr\linewidth-1.7em\relax}{\footnotesize\color{wamuted}#1}\par\nobreak\vspace{0.15em}}
\newcommand{\waansbox}[3]{\par\nobreak\vspace{0.3em}\noindent
  \makebox[2.2em][l]{\bfseries\color{waaccent}#1}%
  \fcolorbox{waline}{white}{\parbox[c][#2][c]{\dimexpr\linewidth-2.2em-3.2em-2\fboxsep-2\fboxrule\relax}{\strut}}%
  \makebox[3.2em][r]{\small\color{wamuted}#3}\par\nobreak}
\newcommand{\waansrule}[2]{\par\nobreak\vspace{0.3em}\noindent
  \makebox[2.2em][l]{\bfseries\color{waaccent}#1}\hfill\makebox[3.2em][r]{\small\color{wamuted}#2}\par\nobreak}
% A part answered by ticking a box in the question: no room to write, just the
% letter, where the answer lives, and what it is worth.
\newcommand{\waansnote}[3]{\par\nobreak\vspace{0.3em}\noindent
  \makebox[2.2em][l]{\bfseries\color{waaccent}#1}%
  \parbox[t]{\dimexpr\linewidth-2.2em-3.2em\relax}{\small\color{wamuted}#2}%
  \makebox[3.2em][r]{\small\color{wamuted}#3}\par\nobreak}
% A group of tick boxes to circle, with the part's letter and its marks.
\newcommand{\waoptset}[3]{\par\vspace{0.35em}\noindent
  \makebox[2.2em][l]{\raisebox{-0.35em}{\wavar{#1}}}%
  \parbox[t]{\dimexpr\linewidth-2.2em-3.2em\relax}{#3}%
  \makebox[3.2em][r]{\small\color{wamuted}#2}\par\vspace{0.35em}}
% Room to work the answer out in, before the answer boxes.
\newcommand{\wawork}[1]{\par\penalty400\vspace{0.8em}\nobreak\noindent
  {\footnotesize\bfseries\color{wamuted}WORKING}\hspace{0.6em}{\color{waline}\hrulefill}\par\nobreak\vspace{0.3em}
  \noindent\fcolorbox{waline}{white}{\parbox[c][#1][c]{\dimexpr\linewidth-2\fboxsep-2\fboxrule\relax}{\strut}}\par}
\newcommand{\waansline}{\par\nobreak\vspace{1.3em}\noindent\hspace*{1.7em}%
  {\color{waline}\rule{\dimexpr\linewidth-1.7em\relax}{0.5pt}}\par\nobreak}

\newcommand{\wasep}{\noalign{\vskip2pt}\noalign{{\color{waline}\hrule height0.4pt}}\noalign{\vskip2pt}}

\newcommand{\watitle}[4]{%
  \noindent\textcolor{waaccent}{\rule{\linewidth}{2.2pt}}\par\vspace{0.6em}%
  \noindent\begin{minipage}[t]{0.7\linewidth}\raggedright
    {\LARGE\bfseries #1}\par\vspace{0.3em}{\color{wamuted}#2}
  \end{minipage}\hfill
  \begin{minipage}[t]{0.28\linewidth}\raggedleft
    {\small\color{wamuted}#3}\par\vspace{0.45em}
    \fcolorbox{waline}{watint}{\small\bfseries #4}
  \end{minipage}\par\vspace{0.7em}%
  \noindent\textcolor{waline}{\rule{\linewidth}{0.6pt}}\par\vspace{0.5em}}

\newcommand{\wadots}[1]{\makebox[#1]{\dotfill}}

% A plain-text copy of a question for readers and machines: typeset in
% invisible ink (PDF text rendering mode 3) inside a box of no height, so it
% extracts with the page's text without showing or shifting anything.
% pdfTeX takes a \pdfliteral; XeTeX (what Tectonic runs) takes the dvipdfmx
% special that ends up as the same PDF operator.
\makeatletter
\ifdefined\pdfliteral
  \newcommand{\wa@ink}[1]{\pdfliteral direct{#1}}
\else
  \newcommand{\wa@ink}[1]{\special{pdf:literal direct #1}}
\fi
% The ink switch lives *inside* the box: a page break between the switch and
% the text would otherwise ship the text on its own page in visible ink, on
% top of whatever is printed there.
\newcommand{\watext}[1]{\par\penalty10000\begingroup
  \vbox to 0pt{\hsize=\linewidth\footnotesize\raggedright
    \wa@ink{3 Tr}\noindent #1\par\wa@ink{0 Tr}\vss}%
  \endgroup\par}
\makeatother`;

export function assignmentToLatex(a: Assignment, meta: ExportMeta = {}): LatexExport {
  const title = meta.title?.trim() || a.name || 'Assignment';
  const subParts = [meta.course, meta.section && `Section ${meta.section}`, meta.term].filter(Boolean) as string[];
  const sub = subParts.join(' \\textperiodcentered{} ');
  const date = (meta.date ?? new Date()).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

  const images: ExportImage[] = [];
  const byUrl = new Map<string, ExportImage>();
  const imgRef = (url: string, alt: string): string | null => {
    if (!isFigure(url)) return null;
    let f = byUrl.get(url);
    if (!f) {
      f = { file: `figure-${byUrl.size + 1}.png`, url, alt };
      byUrl.set(url, f);
      images.push(f);
    }
    if (!f.alt && alt) f.alt = alt;
    return f.file;
  };

  const scheme: { q: number; parts: Part[] }[] = [];
  const blocks = a.questions.map((q) => {
    const root = q.html ? parse(sanitizeQuestionHtml(q.html)) : null;
    const plan: Plan = root
      ? planQuestion(root, q)
      : { optNo: new Map(), staticLabels: [], synthetic: [], subs: new Map(), inlineOpts: new Set(), groupLabel: new Map() };
    const figures: ExportImage[] = [];
    const ctx: Ctx = {
      plan,
      boxes: q.boxes,
      seen: { statics: 0 },
      imgRef: (url, alt) => {
        const file = imgRef(url, alt);
        const fig = file && byUrl.get(url);
        if (fig && !figures.includes(fig)) figures.push(fig);
        return file;
      },
    };
    const body = root ? cleanBody(kids(root, ctx)) : '';
    const parts = partsOf(q, plan, ctx);
    scheme.push({ q: q.number, parts });

    const marks = q.total != null ? `[${q.total} mark${q.total === 1 ? '' : 's'}]` : '';
    const printed = body || cleanBody(textBody(q));
    return [
      `\\waqhead{Question ${q.number}}{${q.code ? escText(q.code) : ''}}{${marks}}{${needSpace(parts, !!meta.workings, printed)}}`,
      printed,
      meta.workings ? `\\wawork{${workingHeight(parts)}}` : '',
      answerArea(parts),
      meta.transcript === false ? '' : transcript(q, figures),
    ].filter(Boolean).join('\n');
  });

  const totalMarks = a.questions.reduce((n, q) => n + (q.total ?? 0), 0);
  const keywords = a.questions.map((q) => q.code).filter(Boolean).join(', ');

  const tex = `\\documentclass[11pt]{article}
${PREAMBLE}
\\hypersetup{
  pdftitle={${escText(title)}},
  pdfauthor={WebAssign Desk},
  pdfsubject={WebAssign assignment worksheet with mark scheme},
  pdfkeywords={${escText(keywords)}},
  pdfcreator={WebAssign Desk},
  pdfproducer={WebAssign Desk / pdfTeX},
}
\\pagestyle{fancy}
\\fancyhf{}
\\lhead{\\footnotesize\\color{wamuted}${escText(title)}}
\\rhead{\\footnotesize\\color{wamuted}${sub || 'WebAssign'}}
\\cfoot{\\footnotesize\\color{wamuted}\\thepage}
\\renewcommand{\\headrule}{{\\color{waline}\\hrule height0.4pt}}

\\begin{document}
\\watitle{${escText(title)}}{${sub || 'WebAssign'}}{${escText(date)}}{${totalMarks ? `Total: ${totalMarks} marks` : 'Worksheet'}}
${meta.nameFields === false ? '' : `
\\noindent{\\small Name:~\\wadots{5.6cm}\\quad Class:~\\wadots{3cm}\\quad Date:~\\wadots{2.6cm}}\\par
\\vspace{0.5em}`}
\\noindent\\fcolorbox{waline}{watint}{\\parbox{\\dimexpr\\linewidth-2\\fboxsep-2\\fboxrule\\relax}{%
  \\small Answer \\textbf{all} questions. Each answer carries the same letter as its placeholder in the
  question: write in the box with that letter, or tick one of the choices beside it. Marks for each
  part are shown in brackets.}}
\\vspace{0.3em}
${meta.transcript === false ? '' : `\\watext{${escText(`Document: ${title}. ${subParts.length ? `${subParts.join(', ')}. ` : ''}A worksheet of ${a.questions.length} questions${totalMarks ? ` worth ${totalMarks} marks` : ''}. Each question is followed by a plain-text transcript for screen readers and machine reading; the answers WebAssign has marked correct are in the mark scheme at the end.`)}}`}

${blocks.join('\n\n')}

\\newpage
${markScheme(scheme)}

\\end{document}
`;

  return { tex, images };
}
