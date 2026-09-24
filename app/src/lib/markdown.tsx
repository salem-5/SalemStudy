import { memo, useMemo } from 'react';
import { Marked, type Tokens } from 'marked';
import { highlight } from './highlight';
import katex from 'katex';
import DOMPurify from 'dompurify';
import 'katex/dist/katex.min.css';
import { repairTex } from './mathText';
export { asMath } from './mathText';

const MATH = [
  { re: /\$\$([\s\S]+?)\$\$/g, display: true },
  { re: /\\\[([\s\S]+?)\\\]/g, display: true },
  { re: /\\\(([\s\S]+?)\\\)/g, display: false },
  { re: /(?<![\\$\w])\$(?!\s)([^$\n]*?\\[a-zA-Z]+[^$\n]*?)\s+\$(?![\w$])/g, display: false },
  { re: /(?<![\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\w$])/g, display: false },
];

const escHtml = (t: string) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

function renderMath(tex: string, display: boolean): string {
  const options = { displayMode: display, throwOnError: true, output: 'html' as const, strict: 'ignore' as const };
  try {
    return katex.renderToString(repairTex(tex.trim()), options);
  } catch {
    return `<span class="math-raw" title="This formula could not be typeset">${escHtml(tex.trim())}</span>`;
  }
}

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
  const code: string[] = [];
  let text = src.replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => `\uE000C${code.push(m) - 1}\uE000`);
  for (const { re, display } of MATH) {
    text = text.replace(re, (_, tex: string) => `\uE000M${slots.push(renderMath(tex, display)) - 1}\uE000`);
  }
  const known = new Map((cites ?? []).map((c) => [c.n, c]));
  if (known.size) {
    text = text.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (m, list: string) => {
      const ns = list.split(',').map((x) => Number(x.trim()));
      return ns.every((n) => known.has(n)) ? ns.map((n) => `\uE000R${n}\uE000`).join('') : m;
    });
  }
  text = text.replace(/\uE000C(\d+)\uE000/g, (_, i) => code[Number(i)]);
  let html = md.parse(text, { async: false }) as string;
  html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');
  html = html.replace(/\uE000M(\d+)\uE000/g, (_, i) => slots[Number(i)]);
  const clean = DOMPurify.sanitize(html, { ADD_ATTR: ['aria-hidden', 'preserveAspectRatio'], FORBID_TAGS: ['style', 'form', 'input', 'button'] });
  return clean.replace(/\uE000R(\d+)\uE000/g, (_, n) => {
    const c = known.get(Number(n))!;
    return `<button type="button" class="cite" data-cite="${c.n}" title="${esc(`${c.title} - ${c.label}`)}">${c.n}</button>`;
  });
}

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
  } catch { }
}

export function Markdown({ text, className, cites, onCite }: { text: string; className?: string; cites?: CiteRef[]; onCite?: (n: number) => void }) {
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
