const OPS: Record<string, string> = {
  '×': '\\times', '·': '\\cdot', '⋅': '\\cdot', '∙': '\\cdot', '÷': '\\div', '∗': '*',
  '±': '\\pm', '∓': '\\mp', '≤': '\\le', '≥': '\\ge', '≦': '\\le', '≧': '\\ge',
  '≠': '\\ne', '≈': '\\approx', '≅': '\\cong', '≡': '\\equiv', '∼': '\\sim', '≃': '\\simeq',
  '∝': '\\propto', '→': '\\to', '←': '\\gets', '↔': '\\leftrightarrow', '↦': '\\mapsto',
  '⇀': '\\rightharpoonup', '⇒': '\\Rightarrow', '⇐': '\\Leftarrow', '⇔': '\\Leftrightarrow',
  '∞': '\\infty', '∑': '\\sum', '∏': '\\prod', '∫': '\\int', '∬': '\\iint', '∮': '\\oint',
  '∂': '\\partial', '∇': '\\nabla', '√': '\\surd', '∛': '\\sqrt[3]{\\;}',
  '∈': '\\in', '∉': '\\notin', '∋': '\\ni', '⊂': '\\subset', '⊆': '\\subseteq',
  '⊃': '\\supset', '⊇': '\\supseteq', '∪': '\\cup', '∩': '\\cap', '∖': '\\setminus',
  '∅': '\\emptyset', '∀': '\\forall', '∃': '\\exists', '∄': '\\nexists', '¬': '\\neg',
  '∧': '\\wedge', '∨': '\\vee', '⊕': '\\oplus', '⊗': '\\otimes', '∘': '\\circ',
  '°': '^\\circ', '′': "'", '″': "''", '‴': "'''", '−': '-', '‐': '-', '–': '-', '—': '-',
  '⟨': '\\langle', '⟩': '\\rangle', '〈': '\\langle', '〉': '\\rangle',
  '⌊': '\\lfloor', '⌋': '\\rfloor', '⌈': '\\lceil', '⌉': '\\rceil',
  '‖': '\\|', '⋯': '\\cdots', '…': '\\dots', '⋮': '\\vdots', '⋱': '\\ddots',
  '∠': '\\angle', '⊥': '\\perp', '∥': '\\parallel', '△': '\\triangle', '□': '\\square',
  '⊙': '\\odot', '∴': '\\therefore', '∵': '\\because', '∆': '\\Delta', '℮': 'e',
  'ℓ': '\\ell', 'ℏ': '\\hbar', 'ℝ': '\\mathbb{R}', 'ℤ': '\\mathbb{Z}', 'ℕ': '\\mathbb{N}',
  'ℚ': '\\mathbb{Q}', 'ℂ': '\\mathbb{C}', 'µ': '\\mu', 'Å': '\\mathrm{\\AA}',
  '≪': '\\ll', '≫': '\\gg', '⌀': '\\emptyset', '％': '\\%', '⁄': '/',
};

const GREEK: Record<string, string> = {
  α: '\\alpha', β: '\\beta', γ: '\\gamma', δ: '\\delta', ε: '\\varepsilon', ϵ: '\\epsilon',
  ζ: '\\zeta', η: '\\eta', θ: '\\theta', ϑ: '\\vartheta', ι: '\\iota', κ: '\\kappa',
  λ: '\\lambda', μ: '\\mu', ν: '\\nu', ξ: '\\xi', ο: 'o', π: '\\pi', ϖ: '\\varpi',
  ρ: '\\rho', ϱ: '\\varrho', σ: '\\sigma', ς: '\\varsigma', τ: '\\tau', υ: '\\upsilon',
  φ: '\\varphi', ϕ: '\\phi', χ: '\\chi', ψ: '\\psi', ω: '\\omega',
  Γ: '\\Gamma', Δ: '\\Delta', Θ: '\\Theta', Λ: '\\Lambda', Ξ: '\\Xi', Π: '\\Pi',
  Σ: '\\Sigma', Υ: '\\Upsilon', Φ: '\\Phi', Ψ: '\\Psi', Ω: '\\Omega',
};

const SCRIPTS: Record<string, string> = {
  '⁰': '^{0}', '¹': '^{1}', '²': '^{2}', '³': '^{3}', '⁴': '^{4}', '⁵': '^{5}',
  '⁶': '^{6}', '⁷': '^{7}', '⁸': '^{8}', '⁹': '^{9}', '⁺': '^{+}', '⁻': '^{-}',
  '₀': '_{0}', '₁': '_{1}', '₂': '_{2}', '₃': '_{3}', '₄': '_{4}', '₅': '_{5}',
  '₆': '_{6}', '₇': '_{7}', '₈': '_{8}', '₉': '_{9}', '₊': '_{+}', '₋': '_{-}',
  'ⁿ': '^{n}', 'ⁱ': '^{i}', 'ₓ': '_{x}', 'ₙ': '_{n}',
};

const VULGAR: Record<string, string> = {
  '½': '\\frac{1}{2}', '⅓': '\\frac{1}{3}', '⅔': '\\frac{2}{3}', '¼': '\\frac{1}{4}',
  '¾': '\\frac{3}{4}', '⅕': '\\frac{1}{5}', '⅙': '\\frac{1}{6}', '⅛': '\\frac{1}{8}',
  '⅜': '\\frac{3}{8}', '⅝': '\\frac{5}{8}', '⅞': '\\frac{7}{8}',
};

const MATH_ALPHA: [number, number, string][] = [
  [0x1d400, 0x1d433, '\\mathbf'], [0x1d434, 0x1d467, '\\mathit'],
  [0x1d468, 0x1d49b, '\\mathbf'], [0x1d504, 0x1d537, '\\mathfrak'],
  [0x1d538, 0x1d56b, '\\mathbb'], [0x1d5a0, 0x1d5d3, '\\mathsf'],
  [0x1d670, 0x1d6a3, '\\mathtt'],
];

function mathAlpha(ch: string): string | null {
  const cp = ch.codePointAt(0) ?? 0;
  for (const [lo, hi, cmd] of MATH_ALPHA) {
    if (cp < lo || cp > hi) continue;
    const n = (cp - lo) % 52;
    const letter = n < 26 ? String.fromCharCode(65 + n) : String.fromCharCode(97 + n - 26);
    return `${cmd}{${letter}}`;
  }
  if (cp >= 0x1d7ce && cp <= 0x1d7ff) return String((cp - 0x1d7ce) % 10);
  return null;
}

const FUNCS = new Set([
  'sin', 'cos', 'tan', 'sec', 'csc', 'cot', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh',
  'coth', 'ln', 'log', 'exp', 'lim', 'max', 'min', 'det', 'gcd', 'sup', 'inf', 'arg', 'deg', 'dim',
  'ker', 'hom', 'Pr',
]);

export const escMath = (s: string): string =>
  s.replace(/([&%$#_{}])/g, '\\$1')
    .replace(/\\/g, '\\backslash ')
    .replace(/[^\x00-\x7F]/gu, (ch) => {
      const m = OPS[ch] ?? GREEK[ch] ?? SCRIPTS[ch] ?? VULGAR[ch] ?? mathAlpha(ch);
      return m ? `${m} ` : '';
    })
    .replace(/\s+/g, ' ');

export const texUnicode = (s: string): string =>
  s.replace(/[^\x00-\x7F]/gu, (ch) => {
    const m = OPS[ch] ?? GREEK[ch] ?? SCRIPTS[ch] ?? VULGAR[ch] ?? mathAlpha(ch);
    return m ? `${m} ` : '';
  });

const UNI_TEXT: Record<string, string> = {
  '—': '---', '–': '--', '‐': '-', '’': "'", '‘': '`', '“': '``', '”': "''",
  '„': ',,', '•': '\\textbullet{}', '·': '$\\cdot$', '§': '\\S{}', '¶': '\\P{}',
  '©': '\\textcopyright{}', '®': '\\textregistered{}', '™': '\\texttrademark{}',
  '€': '\\texteuro{}', '£': '\\pounds{}', '¢': '\\textcent{}', '¥': '\\textyen{}',
  ' ': '~', ' ': '\\,', ' ': '\\ ', ' ': '\\quad{}', '​': '',
  'é': "\\'e", 'è': '\\`e', 'ê': '\\^e', 'ü': '\\"u', 'ö': '\\"o', 'ä': '\\"a',
  'ñ': '\\~n', 'á': "\\'a", 'í': "\\'i", 'ó': "\\'o", 'ú': "\\'u", 'ç': '\\c{c}',
};

export const escText = (s: string): string =>
  s.replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/[^\x00-\x7F]/gu, (ch) => {
      if (UNI_TEXT[ch] !== undefined) return UNI_TEXT[ch];
      const m = OPS[ch] ?? GREEK[ch] ?? SCRIPTS[ch] ?? VULGAR[ch] ?? mathAlpha(ch);
      return m ? `$${m}$` : '';
    });

const PLAIN_MATH = /^[0-9\s.,;:+\-*/()[\]|<>=!'`]*$/;
const SAFE_IN_MATH = /^(\\(times|cdot|div|pm|mp|le|ge|ne|approx|to|infty|pi|theta|alpha|beta|gamma|delta|lambda|mu|omega|Delta|Sigma|Omega|circ|langle|rangle|mathbf|mathit|frac|sqrt|left|right|,|;|:|!)\b|[{}^_])/;

export function asMath(fragment: string): string {
  const parts = fragment.split(/\$([^$]*)\$/g);
  let out = '';
  parts.forEach((p, i) => {
    if (i % 2 === 1) { out += ` ${p} `; return; }
    if (!p.trim()) { out += p.includes(' ') ? '\\,' : ''; return; }
    if (PLAIN_MATH.test(p) || SAFE_IN_MATH.test(p.trim())) { out += p; return; }
    if (/^[A-Za-z]$/.test(p.trim())) { out += p.trim(); return; }
    out += `\\text{${p.trim()}}`;
  });
  const body = out.replace(/\s+/g, ' ').trim();
  return body || '\\;';
}

export const blank = (s: string) => !s.replace(/\\[,;:!]|\s|\\;/g, '').trim();

const OPEN: Record<string, string> = { '(': '(', '[': '[', '{': '\\{', '⟨': '\\langle', '|': '|', '‖': '\\|', '⌊': '\\lfloor', '⌈': '\\lceil' };
const CLOSE: Record<string, string> = { ')': ')', ']': ']', '}': '\\}', '⟩': '\\rangle', '|': '|', '‖': '\\|', '⌋': '\\rfloor', '⌉': '\\rceil' };
const PAIR: Record<string, string> = { '(': ')', '[': ']', '{': '}', '⟨': '⟩', '|': '|', '‖': '‖', '⌊': '⌋', '⌈': '⌉' };

const ACCENTS: Record<string, string> = {
  '⇀': '\\vec', '→': '\\vec', '^': '\\hat', 'ˆ': '\\hat', '~': '\\tilde', '˜': '\\tilde',
  '‾': '\\overline', '¯': '\\overline', '¨': '\\ddot', '˙': '\\dot', '.': '\\dot',
  '⌢': '\\overset{\\frown}', '↔': '\\overleftrightarrow',
};

const INVISIBLE = /^[⁡-⁤​﻿]+$/;

export function mathmlToLatex(mathml: string): string {
  const doc = new DOMParser().parseFromString(mathml || '<math/>', 'application/xml');
  if (doc.documentElement?.localName === 'parsererror' || doc.querySelector('parsererror')) return '';
  return tidy(mml(doc.documentElement));
}

const tidy = (s: string) => s.replace(/\s+/g, ' ').replace(/\{ +/g, '{').replace(/ +\}/g, '}').trim();

function mml(el: Element | undefined | null): string {
  if (!el || el.nodeType !== 1) return '';
  const tag = el.localName;
  const kids = [...el.children];
  const all = () => kids.map((k) => mml(k)).join(' ');
  const txt = () => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

  switch (tag) {
    case 'math': case 'semantics': case 'mstyle': case 'maction':
    case 'mpadded': case 'merror': case 'mrow':
      return fenced(kids);
    case 'mphantom': return `\\phantom{${all()}}`;
    case 'menclose': {
      const n = el.getAttribute('notation') ?? '';
      const body = all();
      if (/box|roundedbox/.test(n)) return `\\boxed{${body}}`;
      if (/top|bottom/.test(n)) return `\\overline{${body}}`;
      if (/radical/.test(n)) return `\\sqrt{${body}}`;
      return body;
    }
    case 'mn': return escMath(txt());
    case 'mi': {
      const t = txt();
      if (!t || INVISIBLE.test(t)) return '';
      if (GREEK[t]) return GREEK[t];
      const variant = el.getAttribute('mathvariant');
      if (variant === 'bold') return `\\mathbf{${escMath(t)}}`;
      if (variant === 'normal') return t.length > 1 && FUNCS.has(t) ? `\\${t}` : `\\mathrm{${escMath(t)}}`;
      if (t.length === 1) return escMath(t);
      return FUNCS.has(t) ? `\\${t}` : `\\mathrm{${escMath(t)}}`;
    }
    case 'mo': {
      const t = txt();
      if (!t || INVISIBLE.test(t)) return '';
      if (GREEK[t]) return GREEK[t];
      if (t.length > 1 && /^[A-Za-z]+$/.test(t)) return FUNCS.has(t) ? `\\${t}` : `\\mathrm{${t}}`;
      return OPS[t] ?? escMath(t);
    }
    case 'mtext': {
      const t = txt();
      if (!t) return '';
      return INVISIBLE.test(t) ? '' : `\\text{${escText(t)}}`;
    }
    case 'ms': return `\\text{"${escText(txt())}"}`;
    case 'mfrac': {
      const num = mml(kids[0]);
      const den = mml(kids[1]);
      const thin = (el.getAttribute('linethickness') ?? '').replace(/\s/g, '');
      if (thin === '0' || thin === '0pt' || thin === '0px') return `\\binom{${num}}{${den}}`;
      return `\\frac{${num}}{${den}}`;
    }
    case 'msup': return `${base(kids[0])}^{${mml(kids[1])}}`;
    case 'msub': return `${base(kids[0])}_{${mml(kids[1])}}`;
    case 'msubsup': return `${base(kids[0])}_{${mml(kids[1])}}^{${mml(kids[2])}}`;
    case 'msqrt': return `\\sqrt{${fenced(kids)}}`;
    case 'mroot': return `\\sqrt[${mml(kids[1])}]{${mml(kids[0])}}`;
    case 'mfenced': {
      const sep = el.getAttribute('separators') ?? ',';
      const open = el.getAttribute('open') ?? '(';
      const close = el.getAttribute('close') ?? ')';
      const body = kids.map((k) => mml(k)).join(`${sep ? escMath(sep[0]) : ''} `);
      return `\\left${OPEN[open] ?? escMath(open) ?? '.'} ${body} \\right${CLOSE[close] ?? escMath(close) ?? '.'}`;
    }
    case 'mover': case 'munder': case 'munderover': {
      const body = mml(kids[0]);
      const under = tag === 'mover' ? null : (kids[1]?.textContent ?? '').trim();
      const over = tag === 'mover' ? (kids[1]?.textContent ?? '').trim()
        : tag === 'munderover' ? (kids[2]?.textContent ?? '').trim() : null;
      if (tag === 'mover' && over && ACCENTS[over]) return `${ACCENTS[over]}{${body}}`;
      if (tag === 'munder' && under === '‾') return `\\underline{${body}}`;
      let out = body;
      if (under) out = `\\underset{${mml(kids[1])}}{${out}}`;
      if (over && tag !== 'munder') out = `\\overset{${mml(kids[tag === 'mover' ? 1 : 2])}}{${out}}`;
      return out;
    }
    case 'mmultiscripts': {
      const b = mml(kids[0]);
      let sub = ''; let sup = ''; let pre = false; let i = 1;
      let preSub = ''; let preSup = '';
      while (i < kids.length) {
        if (kids[i].localName === 'mprescripts') { pre = true; i++; continue; }
        const lo = mml(kids[i]); const hi = mml(kids[i + 1]);
        if (pre) { preSub += lo; preSup += hi; } else { sub += lo; sup += hi; }
        i += 2;
      }
      const prefix = preSub || preSup ? `{}_{${preSub}}^{${preSup}}` : '';
      return `${prefix}${b}${sub ? `_{${sub}}` : ''}${sup ? `^{${sup}}` : ''}`;
    }
    case 'mtable': {
      const rows = kids.filter((r) => r.localName === 'mtr' || r.localName === 'mlabeledtr');
      const cols = Math.max(1, ...rows.map((r) => r.children.length));
      const body = rows.map((r) => [...r.children].map((c) => mml(c)).join(' & ')).join(' \\\\ ');
      const align = (el.getAttribute('columnalign') ?? '').split(/\s+/)[0];
      const kind = align === 'left' ? 'l' : align === 'right' ? 'r' : 'c';
      return `\\begin{array}{${kind.repeat(cols)}}${body}\\end{array}`;
    }
    case 'mtr': case 'mlabeledtr': return [...kids].map((c) => mml(c)).join(' & ');
    case 'mtd': return fenced(kids);
    case 'mspace': {
      const w = el.getAttribute('width') ?? '';
      const n = parseFloat(w);
      if (/em|ex/.test(w) && n >= 1) return '\\quad ';
      return n > 0 ? '\\,' : '';
    }
    case 'mglyph': return escMath(el.getAttribute('alt') ?? '');
    case 'annotation': case 'annotation-xml': case 'mprescripts': case 'none': return '';
    default: return all();
  }
}

function base(el: Element | undefined): string {
  const s = mml(el);
  if (!s) return '{}';
  if (/^[A-Za-z0-9]$/.test(s) || /^\\[A-Za-z]+$/.test(s) || /^\{.*\}$/.test(s)) return s;
  return `{${s}}`;
}

function fenced(kids: Element[]): string {
  const items = kids.filter((k) => !INVISIBLE.test((k.textContent ?? '').trim()) || k.children.length > 0);
  if (items.length >= 2) {
    const first = items[0];
    const last = items[items.length - 1];
    const o = (first.textContent ?? '').trim();
    const c = (last.textContent ?? '').trim();
    if (first.localName === 'mo' && last.localName === 'mo' && OPEN[o] && PAIR[o] === c) {
      const body = items.slice(1, -1).map((k) => mml(k)).join(' ');
      return `\\left${OPEN[o]} ${body} \\right${CLOSE[c]}`;
    }
  }
  return items.map((k) => mml(k)).join(' ');
}
