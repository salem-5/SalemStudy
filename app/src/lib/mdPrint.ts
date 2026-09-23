import { marked } from 'marked';

/**
 * Markdown (with $...$ and $$...$$ maths) into the HTML fragment the PDF
 * renderer lays out.
 *
 * Exports used to go through LaTeX, which meant every student needed a TeX
 * distribution installed before they could save a note as a PDF. They now go
 * through Salem's own Python (see `src-tauri/python/salem_pdf.py`), which
 * takes HTML — so this produces HTML, and hands the maths over in the form
 * the renderer understands: \\(...\\) inline, \\[...\\] displayed.
 *
 * The maths is lifted out before Markdown parsing and put back untouched: a
 * formula full of underscores and asterisks would otherwise be mangled into
 * emphasis on the way through.
 */

const MATH = [
  { re: /\$\$([\s\S]+?)\$\$/g, display: true },
  { re: /\\\[([\s\S]+?)\\\]/g, display: true },
  { re: /\\\(([\s\S]+?)\\\)/g, display: false },
  // A lone $...$, but not a currency amount and not an escaped \$.
  { re: /(?<![\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\w$])/g, display: false },
];

/** A placeholder no Markdown construct can produce, so nothing collides. */
const NUL = String.fromCharCode(0);
const slot = (i: number) => `${NUL}MATH${i}${NUL}`;
const SLOTS = new RegExp(`${NUL}MATH(\\d+)${NUL}`, 'g');

export function markdownToPrintHtml(md: string): string {
  const math: { latex: string; display: boolean }[] = [];
  let src = md;
  for (const { re, display } of MATH) {
    src = src.replace(re, (_whole, inner: string) => {
      math.push({ latex: inner.trim(), display });
      return slot(math.length - 1);
    });
  }

  const html = marked.parse(src, { async: false, gfm: true, breaks: false }) as string;

  // Put the formulas back, in the renderer's delimiters, exactly as written.
  return html.replace(SLOTS, (_whole, n: string) => {
    const item = math[Number(n)];
    if (!item) return '';
    return item.display ? `\\[${item.latex}\\]` : `\\(${item.latex}\\)`;
  });
}

const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/** Plain text as HTML — for a title, a label, a caption. */
export const escapeHtml = (text: string): string => text.replace(/[&<>"]/g, (c) => ESCAPE[c]);

/**
 * Maths that is already LaTeX rather than Markdown — a worked answer out of
 * the solver, a question's own notation — in the renderer's delimiters.
 */
export const inlineMath = (latex: string): string => `\\(${latex}\\)`;
export const displayMath = (latex: string): string => `\\[${latex}\\]`;
