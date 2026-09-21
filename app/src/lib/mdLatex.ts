import { marked, type Token, type Tokens } from 'marked';

/**
 * Markdown (with $…$ / $$…$$ maths) → a complete LaTeX document, for exporting
 * notes as PDF through the same TeX engine the worksheet export uses. The
 * maths is already LaTeX, so it is lifted out before Markdown parsing and put
 * back untouched; everything else is escaped.
 */

const MATH = [
  { re: /\$\$([\s\S]+?)\$\$/g, display: true },
  { re: /\\\[([\s\S]+?)\\\]/g, display: true },
  { re: /\\\(([\s\S]+?)\\\)/g, display: false },
  { re: /(?<![\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\w$])/g, display: false },
];

/** Characters pdflatex cannot take raw, as LaTeX. */
const UNICODE: Record<string, string> = {
  '→': '\\ensuremath{\\to}', '←': '\\ensuremath{\\leftarrow}', '⇒': '\\ensuremath{\\Rightarrow}', '⇔': '\\ensuremath{\\Leftrightarrow}',
  '≤': '\\ensuremath{\\le}', '≥': '\\ensuremath{\\ge}', '≠': '\\ensuremath{\\ne}', '≈': '\\ensuremath{\\approx}', '±': '\\ensuremath{\\pm}',
  '×': '\\ensuremath{\\times}', '·': '\\ensuremath{\\cdot}', '−': '-', '–': '--', '—': '---', '…': '\\ldots{}', '°': '\\ensuremath{^\\circ}',
  '“': '``', '”': "''", '‘': '`', '’': "'", '∞': '\\ensuremath{\\infty}', '√': '\\ensuremath{\\surd}', '∑': '\\ensuremath{\\sum}',
  '∫': '\\ensuremath{\\int}', '∂': '\\ensuremath{\\partial}', '∇': '\\ensuremath{\\nabla}', '∈': '\\ensuremath{\\in}',
  'α': '\\ensuremath{\\alpha}', 'β': '\\ensuremath{\\beta}', 'γ': '\\ensuremath{\\gamma}', 'δ': '\\ensuremath{\\delta}', 'ε': '\\ensuremath{\\varepsilon}',
  'θ': '\\ensuremath{\\theta}', 'λ': '\\ensuremath{\\lambda}', 'μ': '\\ensuremath{\\mu}', 'π': '\\ensuremath{\\pi}', 'σ': '\\ensuremath{\\sigma}',
  'τ': '\\ensuremath{\\tau}', 'φ': '\\ensuremath{\\varphi}', 'ω': '\\ensuremath{\\omega}', 'Δ': '\\ensuremath{\\Delta}', 'Σ': '\\ensuremath{\\Sigma}',
  'Ω': '\\ensuremath{\\Omega}', '✓': '\\ensuremath{\\checkmark}', '•': '\\textbullet{}',
};

export function escapeTex(text: string): string {
  return text
    .replace(/\\/g, '\u0001')
    .replace(/([{}$&#%_])/g, '\\$1')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/</g, '\\textless{}')
    .replace(/>/g, '\\textgreater{}')
    .replace(/\u0001/g, '\\textbackslash{}')
    .replace(/[→←⇒⇔≤≥≠≈±×·−–—…°“”‘’∞√∑∫∂∇∈αβγδεθλμπστφωΔΣΩ✓•]/g, (c) => UNICODE[c] ?? c);
}

export function markdownToLatex(md: string, title: string): string {
  const math: string[] = [];
  let src = md;
  for (const { re, display } of MATH) {
    src = src.replace(re, (_, tex: string) => `\uE000${math.push(display ? `\\[${tex.trim()}\\]` : `$${tex.trim()}$`) - 1}\uE000`);
  }
  // The title line becomes \title; the body starts after it.
  const lines = src.split('\n');
  const h1 = lines.findIndex((l) => /^#\s+/.test(l));
  if (h1 >= 0 && lines.slice(0, h1).every((l) => !l.trim())) lines.splice(h1, 1);
  const tokens = marked.lexer(lines.join('\n'), { gfm: true });

  const restore = (s: string) => s.replace(/\uE000(\d+)\uE000/g, (_, i) => math[Number(i)]);
  const text = (s: string) => restore(escapeTex(s));

  const inline = (ts: Token[] | undefined): string => (ts ?? []).map((t) => {
    switch (t.type) {
      case 'strong': return `\\textbf{${inline((t as Tokens.Strong).tokens)}}`;
      case 'em': return `\\emph{${inline((t as Tokens.Em).tokens)}}`;
      case 'del': return `\\sout{${inline((t as Tokens.Del).tokens)}}`;
      case 'codespan': return `\\texttt{${text((t as Tokens.Codespan).text)}}`;
      case 'br': return '\\\\\n';
      case 'link': {
        const l = t as Tokens.Link;
        return `\\href{${l.href.replace(/([%#\\])/g, '\\$1')}}{${inline(l.tokens)}}`;
      }
      case 'escape': return text((t as Tokens.Escape).text);
      case 'text': {
        const tt = t as Tokens.Text;
        return tt.tokens ? inline(tt.tokens) : text(tt.text);
      }
      default: return 'text' in t && typeof t.text === 'string' ? text(t.text) : '';
    }
  }).join('');

  const block = (ts: Token[]): string => ts.map((t): string => {
    switch (t.type) {
      case 'heading': {
        const h = t as Tokens.Heading;
        const cmd = h.depth <= 2 ? 'section*' : h.depth === 3 ? 'subsection*' : 'subsubsection*';
        return `\\${cmd}{${inline(h.tokens)}}\n`;
      }
      case 'paragraph': {
        const body = inline((t as Tokens.Paragraph).tokens);
        return `${body}\n\n`;
      }
      case 'list': {
        const l = t as Tokens.List;
        const env = l.ordered ? 'enumerate' : 'itemize';
        const items = l.items.map((it) => `  \\item ${block(it.tokens).trim()}\n`).join('');
        return `\\begin{${env}}\n${items}\\end{${env}}\n\n`;
      }
      case 'text': {
        const tt = t as Tokens.Text;
        return `${tt.tokens ? inline(tt.tokens) : text(tt.text)}\n`;
      }
      case 'code': return `\\begin{verbatim}\n${(t as Tokens.Code).text.replace(/\\end\{verbatim\}/g, '\\end {verbatim}')}\n\\end{verbatim}\n\n`;
      case 'blockquote': return `\\begin{quote}\n${block((t as Tokens.Blockquote).tokens)}\\end{quote}\n\n`;
      case 'hr': return '\\medskip\\hrule\\medskip\n\n';
      case 'table': {
        const tb = t as Tokens.Table;
        const n = tb.header.length;
        const col = `>{\\raggedright\\arraybackslash}p{\\dimexpr\\linewidth/${n}-2\\tabcolsep\\relax}`;
        const row = (cells: Tokens.TableCell[]) => cells.map((c) => inline(c.tokens)).join(' & ');
        return `\\begin{center}\\small\n\\begin{tabular}{${Array(n).fill(col).join('')}}\n\\toprule\n${row(tb.header)} \\\\\n\\midrule\n${tb.rows.map((r) => `${row(r)} \\\\`).join('\n')}\n\\bottomrule\n\\end{tabular}\n\\end{center}\n\n`;
      }
      case 'space': return '';
      default: return 'text' in t && typeof t.text === 'string' ? `${text(t.text)}\n\n` : '';
    }
  }).join('');

  return `\\documentclass[11pt]{article}
\\usepackage{iftex}
\\ifPDFTeX
  \\usepackage[utf8]{inputenc}
  \\usepackage[T1]{fontenc}
  \\usepackage{lmodern}
\\fi
\\usepackage{amsmath,amssymb,mathtools}
\\usepackage[margin=2.2cm]{geometry}
\\usepackage{array,booktabs}
\\usepackage[normalem]{ulem}
\\usepackage{enumitem}
\\setlist{itemsep=2pt,topsep=3pt}
\\usepackage[hidelinks]{hyperref}
\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{6pt}
\\title{${text(title)}}
\\date{}
\\begin{document}
\\maketitle
${block(tokens)}
\\end{document}
`;
}
