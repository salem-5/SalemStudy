import { memo, useMemo } from 'react';
import { Marked, type Tokens } from 'marked';
import { highlight } from './highlight';
import katex from 'katex';
import DOMPurify from 'dompurify';
import 'katex/dist/katex.min.css';

/**
 * Markdown with LaTeX for model output, cards and quiz questions. Maths is
 * pulled out before Markdown sees it (so `_` and `*` inside formulas survive),
 * rendered with KaTeX, and put back; the result is sanitised because it comes
 * from a model.
 */

const MATH = [
  { re: /\$\$([\s\S]+?)\$\$/g, display: true },
  { re: /\\\[([\s\S]+?)\\\]/g, display: true },
  { re: /\\\(([\s\S]+?)\\\)/g, display: false },
  // Inline $…$: not $ followed by a digit-and-space (prices), no newline inside.
  { re: /(?<![\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\w$])/g, display: false },
];

function renderMath(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex.trim(), { displayMode: display, throwOnError: false, output: 'html', strict: 'ignore' });
  } catch {
    return `<code>${tex.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</code>`;
  }
}

/** Fenced code: a header with the language and a copy control, then highlighted code. */
const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }: Tokens.Code) {
      const { html, lang: shown } = highlight(text, lang);
      return `<div class="codeblock"><div class="codeblock-head"><span class="codeblock-lang">${shown}</span><span class="code-copy" role="button" tabindex="0" title="Copy code">Copy</span></div><pre><code class="hljs">${html}</code></pre></div>`;
    },
  },
});

export type CiteRef = { n: number; title: string; label: string };

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function renderMarkdown(src: string, cites?: CiteRef[]): string {
  const slots: string[] = [];
  // Placeholders are wrapped in U+E000 (private use): Markdown and DOMPurify
  // leave it alone, unlike NUL, which DOMPurify strips.
  // Leave code alone: fenced blocks and inline code are protected first.
  const code: string[] = [];
  let text = src.replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => `\uE000C${code.push(m) - 1}\uE000`);
  for (const { re, display } of MATH) {
    text = text.replace(re, (_, tex: string) => `\uE000M${slots.push(renderMath(tex, display)) - 1}\uE000`);
  }
  // Citation markers like [2] or [1, 3] become chips, but only for numbers the
  // answer was actually given; anything else stays literal text.
  const known = new Map((cites ?? []).map((c) => [c.n, c]));
  if (known.size) {
    text = text.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (m, list: string) => {
      const ns = list.split(',').map((x) => Number(x.trim()));
      return ns.every((n) => known.has(n)) ? ns.map((n) => `\uE000R${n}\uE000`).join('') : m;
    });
  }
  text = text.replace(/\uE000C(\d+)\uE000/g, (_, i) => code[Number(i)]);
  let html = md.parse(text, { async: false }) as string;
  // Wide tables scroll sideways in their own box instead of squeezing their columns.
  html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');
  html = html.replace(/\uE000M(\d+)\uE000/g, (_, i) => slots[Number(i)]);
  const clean = DOMPurify.sanitize(html, { ADD_ATTR: ['aria-hidden', 'preserveAspectRatio'], FORBID_TAGS: ['style', 'form', 'input', 'button'] });
  // Chips go in after sanitising; their text comes from our own citation list.
  return clean.replace(/\uE000R(\d+)\uE000/g, (_, n) => {
    const c = known.get(Number(n))!;
    return `<button type="button" class="cite" data-cite="${c.n}" title="${esc(`${c.title} — ${c.label}`)}">${c.n}</button>`;
  });
}

/**
 * Split long Markdown into top-level blocks (never inside a code fence or a
 * $$ display), so a streaming note only re-renders the block still growing.
 */
export function splitBlocks(text: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let fence = false;
  let display = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && ((line.match(/\$\$/g) ?? []).length % 2 === 1)) display = !display;
    if (!line.trim() && !fence && !display && cur.length) {
      out.push(cur.join('\n'));
      cur = [];
      continue;
    }
    cur.push(line);
  }
  if (cur.length) out.push(cur.join('\n'));
  return out;
}

const Block = memo(function Block({ text, cites }: { text: string; cites?: CiteRef[] }) {
  const html = useMemo(() => renderMarkdown(text, cites), [text, cites]);
  return <div className="md-block" dangerouslySetInnerHTML={{ __html: html }} />;
});

async function copyText(text: string, el: HTMLElement) {
  try {
    await navigator.clipboard.writeText(text);
    el.textContent = 'Copied';
    el.classList.add('done');
    window.setTimeout(() => { el.textContent = 'Copy'; el.classList.remove('done'); }, 1400);
  } catch { /* clipboard unavailable */ }
}

export function Markdown({ text, className, cites, onCite }: { text: string; className?: string; cites?: CiteRef[]; onCite?: (n: number) => void }) {
  // Long text is rendered block by block; short text in one go (lists and
  // paragraphs then share one parse, which keeps loose lists together).
  const blocks = useMemo(() => (text.length > 2500 ? splitBlocks(text) : [text]), [text]);
  return (
    <div
      className={`md${className ? ` ${className}` : ''}`}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        const copy = target.closest<HTMLElement>('.code-copy');
        if (copy) {
          const code = copy.closest('.codeblock')?.querySelector('code')?.textContent ?? '';
          void copyText(code, copy);
          return;
        }
        const chip = target.closest<HTMLElement>('.cite');
        if (chip && onCite) onCite(Number(chip.dataset.cite));
      }}
    >
      {blocks.map((b, i) => <Block key={i} text={b} cites={cites} />)}
    </div>
  );
}
