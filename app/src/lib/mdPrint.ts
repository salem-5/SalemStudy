import { marked } from 'marked';

const MATH = [
  { re: /\$\$([\s\S]+?)\$\$/g, display: true },
  { re: /\\\[([\s\S]+?)\\\]/g, display: true },
  { re: /\\\(([\s\S]+?)\\\)/g, display: false },
  { re: /(?<![\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\w$])/g, display: false },
];

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

  return html.replace(SLOTS, (_whole, n: string) => {
    const item = math[Number(n)];
    if (!item) return '';
    return item.display ? `\\[${item.latex}\\]` : `\\(${item.latex}\\)`;
  });
}

const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

export const escapeHtml = (text: string): string => text.replace(/[&<>"]/g, (c) => ESCAPE[c]);

export const inlineMath = (latex: string): string => `\\(${latex}\\)`;
export const displayMath = (latex: string): string => `\\[${latex}\\]`;
