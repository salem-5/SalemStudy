import type { Assignment, Box, Question } from '../types';
import { questionStatus } from './format';
import { sanitizeQuestionHtml } from './sanitize';
import { mathValueText } from './render';

// ---------------------------------------------------------------------------
// MathML -> LaTeX
// ---------------------------------------------------------------------------

const OPS: Record<string, string> = {
  '×': '\\times', '·': '\\cdot', '⋅': '\\cdot', '÷': '\\div', '±': '\\pm', '∓': '\\mp',
  '≤': '\\le', '≥': '\\ge', '≠': '\\ne', '≈': '\\approx', '∼': '\\sim', '∝': '\\propto',
  '→': '\\to', '⇒': '\\Rightarrow', '⇔': '\\Leftrightarrow', '∞': '\\infty',
  '∑': '\\sum', '∏': '\\prod', '∫': '\\int', '∂': '\\partial', '∇': '\\nabla', '√': '\\sqrt{}',
  '∈': '\\in', '∉': '\\notin', '⊂': '\\subset', '⊆': '\\subseteq', '∪': '\\cup', '∩': '\\cap',
  '∅': '\\emptyset', '°': '^\\circ', '−': '-', '⟨': '\\langle', '⟩': '\\rangle',
  '‖': '\\|', '⋯': '\\cdots', '…': '\\dots',
};

const GREEK: Record<string, string> = {
  α: '\\alpha', β: '\\beta', γ: '\\gamma', δ: '\\delta', ε: '\\epsilon', ζ: '\\zeta',
  η: '\\eta', θ: '\\theta', ι: '\\iota', κ: '\\kappa', λ: '\\lambda', μ: '\\mu', ν: '\\nu',
  ξ: '\\xi', π: '\\pi', ρ: '\\rho', σ: '\\sigma', τ: '\\tau', υ: '\\upsilon', φ: '\\phi',
  χ: '\\chi', ψ: '\\psi', ω: '\\omega',
  Γ: '\\Gamma', Δ: '\\Delta', Θ: '\\Theta', Λ: '\\Lambda', Ξ: '\\Xi', Π: '\\Pi',
  Σ: '\\Sigma', Υ: '\\Upsilon', Φ: '\\Phi', Ψ: '\\Psi', Ω: '\\Omega',
};

const FUNCS = new Set([
  'sin', 'cos', 'tan', 'sec', 'csc', 'cot', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh',
  'coth', 'ln', 'log', 'exp', 'lim', 'max', 'min', 'det', 'gcd', 'sup', 'inf', 'arg', 'deg',
]);

const escMath = (s: string) =>
  s.replace(/([&%$#_{}])/g, '\\$1').replace(/[^\x00-\x7F]/g, (ch) => OPS[ch] ?? GREEK[ch] ?? '');

const UNI_TEXT: Record<string, string> = {
  '−': '$-$', '×': '$\\times$', '·': '$\\cdot$', '⋅': '$\\cdot$', '÷': '$\\div$', '±': '$\\pm$',
  '≤': '$\\le$', '≥': '$\\ge$', '≠': '$\\ne$', '≈': '$\\approx$', '∼': '$\\sim$', '∝': '$\\propto$',
  '→': '$\\to$', '⇒': '$\\Rightarrow$', '⇔': '$\\Leftrightarrow$', '∞': '$\\infty$',
  '∑': '$\\sum$', '∏': '$\\prod$', '∫': '$\\int$', '∂': '$\\partial$', '∇': '$\\nabla$', '√': '$\\sqrt{\\;}$',
  '∈': '$\\in$', '∉': '$\\notin$', '⊂': '$\\subset$', '⊆': '$\\subseteq$', '∪': '$\\cup$', '∩': '$\\cap$',
  '∅': '$\\emptyset$', '°': '$^\\circ$', '⟨': '$\\langle$', '⟩': '$\\rangle$', '‖': '$\\|$',
  '⋯': '$\\cdots$', '…': '$\\dots$', 'π': '$\\pi$', 'θ': '$\\theta$', 'Δ': '$\\Delta$',
  'α': '$\\alpha$', 'β': '$\\beta$', 'γ': '$\\gamma$', 'δ': '$\\delta$', 'λ': '$\\lambda$', 'μ': '$\\mu$',
  'φ': '$\\phi$', 'ω': '$\\omega$', 'Σ': '$\\Sigma$', 'Ω': '$\\Omega$',
  '—': '---', '–': '--', '’': "'", '‘': "'", '“': '``', '”': "''", '′': "$'$", '″': "$''$", ' ': ' ',
};

const escText = (s: string) =>
  s.replace(/\\/g, '\\textbackslash{}').replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}').replace(/\^/g, '\\textasciicircum{}')
    .replace(/[^\x00-\x7F]/g, (ch) => UNI_TEXT[ch] ?? '');

export function mathmlToLatex(mathml: string): string {
  const doc = new DOMParser().parseFromString(mathml || '<math/>', 'application/xml');
  if (doc.documentElement?.localName === 'parsererror' || doc.querySelector('parsererror')) return '';
  return mml(doc.documentElement);
}

function mml(el: Element | undefined): string {
  if (!el || el.nodeType !== 1) return '';
  const tag = el.localName;
  const kids = [...el.children];
  const all = () => kids.map((k) => mml(k)).join('');
  const txt = () => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  switch (tag) {
    case 'math': case 'mrow': case 'mstyle': case 'semantics': case 'maction':
    case 'mpadded': case 'mphantom': case 'merror': case 'menclose':
      return all();
    case 'mn': return escMath(txt());
    case 'mi': {
      const t = txt();
      if (GREEK[t]) return GREEK[t];
      if (el.getAttribute('mathvariant') === 'normal') return `\\mathrm{${escMath(t)}}`;
      if (t.length === 1) return escMath(t);
      return FUNCS.has(t) ? `\\${t}` : `\\mathit{${escMath(t)}}`;
    }
    case 'mo': {
      const t = txt();
      if (GREEK[t]) return GREEK[t];
      return OPS[t] ?? escMath(t);
    }
    case 'mtext': return `\\text{${escText(txt())}}`;
    case 'mfrac': return `\\frac{${mml(kids[0])}}{${mml(kids[1])}}`;
    case 'msup': return `{${mml(kids[0])}}^{${mml(kids[1])}}`;
    case 'msub': return `{${mml(kids[0])}}_{${mml(kids[1])}}`;
    case 'msubsup': return `{${mml(kids[0])}}_{${mml(kids[1])}}^{${mml(kids[2])}}`;
    case 'msqrt': return `\\sqrt{${all()}}`;
    case 'mroot': return `\\sqrt[${mml(kids[1])}]{${mml(kids[0])}}`;
    case 'mfenced': {
      const sep = el.getAttribute('separators') ?? ',';
      const open = el.getAttribute('open') ?? '(';
      const close = el.getAttribute('close') ?? ')';
      const lo = open === '<' ? '\\langle' : open === '{' ? '\\lbrace' : escMath(open);
      const lc = close === '>' ? '\\rangle' : close === '}' ? '\\rbrace' : escMath(close);
      const body = kids.map((k) => mml(k)).join(`${escMath(sep)} `);
      return `\\left${lo} ${body} \\right${lc}`;
    }
    case 'mover': {
      const acc = (kids[1]?.textContent ?? '').trim();
      if (acc === '⇀' || acc === '→') return `\\vec{${mml(kids[0])}}`;
      if (acc === '^') return `\\hat{${mml(kids[0])}}`;
      if (acc === '‾' || acc === '¯') return `\\overline{${mml(kids[0])}}`;
      return `\\overset{${mml(kids[1])}}{${mml(kids[0])}}`;
    }
    case 'munder': return `\\underset{${mml(kids[1])}}{${mml(kids[0])}}`;
    case 'munderover': return `\\underset{${mml(kids[1])}}{\\overset{${mml(kids[2])}}{${mml(kids[0])}}}`;
    case 'mtable': return `\\begin{matrix}${kids.map((r) => [...r.children].map((c) => mml(c)).join(' & ')).join(' \\\\ ')}\\end{matrix}`;
    case 'mtr': return kids.map((c) => mml(c)).join(' & ');
    case 'mtd': return all();
    case 'mspace': return '\\,';
    case 'mglyph': case 'annotation': case 'annotation-xml': return '';
    default: return all();
  }
}

// ---------------------------------------------------------------------------
// Question HTML -> LaTeX (collecting figures)
// ---------------------------------------------------------------------------

export type ExportImage = { file: string; url: string };
export type LatexExport = { tex: string; images: ExportImage[]; ai: string };

const BLOCK = new Set(['p', 'div', 'section', 'article', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'table', 'ul', 'ol']);
const isFigure = (url: string) => /^https?:/i.test(url) && !/\/watex\/img\//i.test(url) && !/mathtype|overlay|mcorrect|mincorrect|mpartial/i.test(url);

/** Figure width from the markup (px/em/pt/%) as a fraction of \linewidth. */
function imgWidth(el: Element): string {
  const style = el.getAttribute('style') ?? '';
  const m = /width:\s*([\d.]+)\s*(px|em|pt|%)/i.exec(style);
  const clamp = (f: number) => `${Math.max(0.12, Math.min(1, f)).toFixed(2)}\\linewidth`;
  if (m) {
    const n = Number(m[1]);
    if (m[2] === '%') return clamp(n / 100);
    if (m[2] === 'px') return clamp(n / 640);
    if (m[2] === 'pt') return clamp(n / 480);
    if (m[2] === 'em') return clamp(n / 40);
  }
  const w = Number(el.getAttribute('width'));
  if (w) return clamp(w / 640);
  return '0.5\\linewidth';
}

function htmlToLatex(html: string, imgRef: (url: string) => string | null, kindOf: (i: number) => string | undefined): string {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html');
  const root = doc.getElementById('root');
  if (!root) return '';
  let out = '';
  const walk = (node: Node) => {
    if (node.nodeType === 3) { out += escText(node.nodeValue ?? ''); return; }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.localName;
    if (el.classList.contains('wa-static') || el.classList.contains('wa-slot')) { out += '\\rule{2.2cm}{0.4pt}'; return; }
    if (el.classList.contains('wa-opt')) {
      const kind = kindOf(Number(el.getAttribute('data-box')));
      out += (kind === 'checkboxes' ? '$\\square$' : '$\\bigcirc$') + '\\,';
      return;
    }
    if (tag === 'math') { const m = mml(el); if (m) out += `$${m}$`; return; }
    if (tag === 'img') {
      const f = imgRef(el.getAttribute('src') ?? '');
      if (f) out += `\\begin{center}\\includegraphics[width=${imgWidth(el)},keepaspectratio]{${f}}\\end{center}\n`;
      return;
    }
    if (tag === 'br') { out += '\\\\\n'; return; }
    if (tag === 'hr') { out += '\\par\\noindent\\rule{\\linewidth}{0.4pt}\\par\n'; return; }
    if (tag === 'strong' || tag === 'b') { out += '\\textbf{'; [...el.childNodes].forEach(walk); out += '}'; return; }
    if (tag === 'em' || tag === 'i') { out += '\\emph{'; [...el.childNodes].forEach(walk); out += '}'; return; }
    if (tag === 'li') { out += '\\item '; [...el.childNodes].forEach(walk); out += '\n'; return; }
    if (tag === 'ul' || tag === 'ol') { out += '\\begin{itemize}\n'; [...el.childNodes].forEach(walk); out += '\\end{itemize}\n'; return; }
    // WebAssign lays out equations as stacked lines; keep each on its own line.
    if (el.classList.contains('stackline')) {
      if (out.trim() && !out.endsWith('\n')) out += '\\\\\n';
      [...el.childNodes].forEach(walk);
      return;
    }
    if (tag === 'tr') { [...el.childNodes].forEach(walk); out += '\\\\\n'; return; }
    if (tag === 'td' || tag === 'th') { [...el.childNodes].forEach(walk); out += '\\quad '; return; }
    if (BLOCK.has(tag)) { out += '\n'; [...el.childNodes].forEach(walk); out += '\n'; return; }
    [...el.childNodes].forEach(walk);
  };
  walk(root);
  return out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function textToLatex(text: string): string {
  return text
    .split(/(\[\d+\]|\[image: [^\]]+\])/g)
    .map((p) => {
      if (/^\[\d+\]$/.test(p)) return '\\rule{2.2cm}{0.4pt}';
      if (/^\[image:/.test(p)) return '\\textit{[figure]}';
      return escText(p);
    })
    .join('')
    .replace(/\n/g, '\\\\\n');
}

function questionBody(q: Question, imgRef: (url: string) => string | null): string {
  const kindOf = (i: number) => q.boxes[i - 1]?.kind;
  if (q.html) {
    const body = htmlToLatex(sanitizeQuestionHtml(q.html), imgRef, kindOf);
    if (body) return cleanBody(body);
  }
  return cleanBody(textToLatex(q.text));
}

/**
 * A `\\` at the start of a line/paragraph is a LaTeX error ("no line here to
 * end"); drop those and tidy whitespace.
 */
function cleanBody(s: string): string {
  return s
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(^|\n)[ \t]*\\\\[ \t]*(?=\n|$)/g, '$1')
    .replace(/(^|\n)[ \t]*\\\\/g, '$1')
    .trim();
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

const choiceLabel = (b: Box, v: string) => b.choices?.find((c) => c.value === v)?.label ?? v;

function boxAnswer(b: Box): string | null {
  switch (b.kind) {
    case 'math': {
      const latex = mathmlToLatex(b.value);
      return latex ? `$${latex}$` : null;
    }
    case 'choice':
      return b.value ? escText(choiceLabel(b, b.value)) : null;
    case 'checkboxes':
      return b.value ? b.value.split(',').map((v) => escText(choiceLabel(b, v))).join(', ') : null;
    case 'multiselect':
      return b.value ? b.value.split(',').filter(Boolean).map((v) => escText(choiceLabel(b, v))).join(', ') : null;
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

/** Fully correct? Past assignments have no boxes, so fall back to score/total. */
function isCorrect(q: Question): boolean {
  if (q.boxes.length) return questionStatus(q) === 'correct';
  return q.score != null && q.total != null && q.total > 0 && q.score >= q.total;
}

/** Answers read from the markup when there are no boxes (closed/past questions). */
function staticAnswers(q: Question): string[] {
  if (!q.html) return [];
  const doc = new DOMParser().parseFromString(`<div id="r">${sanitizeQuestionHtml(q.html)}</div>`, 'text/html');
  const root = doc.getElementById('r');
  if (!root) return [];
  const out: string[] = [];
  root.querySelectorAll<HTMLElement>('.wa-static, .static-chosen').forEach((el) => {
    if (el.classList.contains('wa-static')) {
      const math = el.querySelector('math');
      if (math) {
        const latex = mathmlToLatex(new XMLSerializer().serializeToString(math));
        if (latex) out.push(`$${latex}$`);
        return;
      }
    }
    const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (t) out.push(escText(t));
  });
  return out;
}

/** Answers for a fully-correct question, or null when it was wrong/unanswered. */
function answerKey(q: Question): string | null {
  if (!isCorrect(q)) return null;
  if (!q.boxes.length) {
    const statics = staticAnswers(q);
    return statics.length ? statics.join('\\quad ') : null;
  }
  const parts = q.boxes.map((b) => {
    const a = boxAnswer(b);
    return q.boxes.length > 1 ? `[${b.index}] ${a ?? '\\rule{1.5cm}{0.4pt}'}` : (a ?? '');
  });
  const joined = parts.filter(Boolean).join('\\quad ');
  return joined || null;
}

// ---------------------------------------------------------------------------
// AI-readable reference
// ---------------------------------------------------------------------------

function aiReference(a: Assignment, meta: ExportMeta): string {
  const data = {
    source: 'WebAssign Desk',
    generated: new Date().toISOString(),
    assignment: { name: a.name, course: meta.course ?? null, section: meta.section ?? null, term: meta.term ?? null },
    questions: a.questions.map((q) => ({
      number: q.number,
      code: q.code ?? null,
      points: q.total ?? null,
      status: questionStatus(q),
      problem: q.text.replace(/Press Space or Enter to edit this math answer\.?/gi, '').trim(),
      boxes: q.boxes.map((b) => ({
        index: b.index,
        kind: b.kind,
        choices: b.choices?.map((c) => c.label) ?? null,
        answer: plainAnswer(b),
        status: b.status,
      })),
    })),
  };
  return JSON.stringify(data, null, 2)
    // Keep it ASCII so pdfLaTeX can typeset it; \uXXXX is still valid JSON.
    .replace(/[^\x00-\x7F]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export type ExportMeta = { course?: string; section?: string; term?: string; date?: Date };

export function assignmentToLatex(a: Assignment, meta: ExportMeta = {}): LatexExport {
  const title = a.name || 'Assignment';
  const sub = [meta.course, meta.section && `Section ${meta.section}`, meta.term].filter(Boolean).join(' · ');
  const date = (meta.date ?? new Date()).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

  const images: ExportImage[] = [];
  const byUrl = new Map<string, string>();
  const imgRef = (url: string): string | null => {
    if (!isFigure(url)) return null;
    let f = byUrl.get(url);
    if (!f) {
      f = `figure-${byUrl.size + 1}.png`;
      byUrl.set(url, f);
      images.push({ file: f, url });
    }
    return f;
  };

  const questions = a.questions.map((q) => {
    const head = `\\textbf{${q.number}.}${q.code ? ` \\hfill \\textnormal{\\small\\color{gray} ${escText(q.code)}}` : ''}\n\n`;
    return head + questionBody(q, imgRef);
  }).join('\n\\item ');

  const keys = a.questions.map((q) => answerKey(q) ?? '\\hfill');
  const anyKey = a.questions.some((q) => answerKey(q) !== null);
  const ai = aiReference(a, meta);
  const keywords = a.questions.map((q) => q.code).filter(Boolean).join(', ');

  const tex = `\\documentclass[11pt]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath,amssymb}
\\usepackage{lmodern}
\\usepackage[T1]{fontenc}
\\usepackage{microtype}
\\usepackage{enumitem}
\\usepackage{graphicx}
\\usepackage{xcolor}
\\usepackage{parskip}
\\usepackage{fancyhdr}
\\usepackage{embedfile}
\\usepackage[hidelinks]{hyperref}
\\hypersetup{
  pdftitle={${escText(title)}},
  pdfauthor={WebAssign Desk},
  pdfsubject={WebAssign assignment, problems and answer key},
  pdfkeywords={${escText(keywords)}},
  pdfcreator={WebAssign Desk},
  pdfproducer={WebAssign Desk / pdfTeX},
}
\\pagestyle{fancy}
\\fancyhf{}
\\lhead{\\small\\textsc{${escText(title)}}}
\\rhead{\\small ${escText(sub || 'WebAssign')}}
\\cfoot{\\thepage}
\\renewcommand{\\headrulewidth}{0.4pt}
\\setlist[enumerate,1]{label=\\textbf{\\arabic*.}, leftmargin=*, itemsep=1.4em}
\\begin{document}
\\embedfile[desc={WebAssign AI reference}, mimetype={application/json}]{ai-reference.json}

\\begin{center}
  {\\LARGE\\bfseries ${escText(title)}}\\\\[0.4em]
  {\\large ${escText(sub || 'WebAssign')}}\\\\[0.3em]
  {\\small\\color{gray} ${escText(date)}}
\\end{center}
\\vspace{1em}
\\hrule
\\vspace{1.2em}

\\section*{Problems}
\\begin{enumerate}
\\item ${questions}
\\end{enumerate}

\\vfill
\\newpage
\\section*{Answer Key}
${anyKey
    ? `\\begin{enumerate}[label=\\textbf{\\arabic*.}, leftmargin=*, itemsep=0.8em]\n${keys.map((k) => `\\item ${k}`).join('\n')}\n\\end{enumerate}`
    : '\\textit{No answers to show (nothing was graded correct).}'}

\\end{document}
`;

  return { tex, images, ai };
}
