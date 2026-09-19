import { renderable } from './render';

// Question HTML comes from WebAssign through the userscript (already cleaned
// there). It is cleaned again here because it lands in a webview that can call
// Tauri commands.

const DROP = [
  'script, style, noscript, iframe, frame, object, embed, link, meta, base, form, button, input, select, textarea',
  // WebAssign's grading badges and pad chrome; the app shows its own status.
  // (.waMark itself is unwrapped, not dropped: on closed questions it wraps the choices.)
  '.badgeWrap, .padMark, .mathtype-sr-only, .latex-source, .tooltip',
].join(', ');
const URL_ATTRS = ['href', 'src', 'xlink:href', 'action', 'formaction', 'background', 'poster'];

let ctx: CanvasRenderingContext2D | null = null;

function luminance(value: string): number | null {
  ctx ??= document.createElement('canvas').getContext('2d');
  if (!ctx || !value) return null;
  ctx.fillStyle = '#010203';
  ctx.fillStyle = value;
  const v = String(ctx.fillStyle);
  if (v === '#010203') return null;
  let r: number; let g: number; let b: number; let a = 1;
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const n = parseInt(hex[1], 16);
    [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255];
  } else {
    const m = /rgba?\(([^)]+)\)/.exec(v);
    if (!m) return null;
    [r, g, b, a = 1] = m[1].split(',').map(Number);
  }
  if (a === 0) return null;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

const dark = (v: string) => { const l = luminance(v); return l !== null && l < 0.45; };
const light = (v: string) => { const l = luminance(v); return l !== null && l > 0.75; };

// ---------------------------------------------------------------------------
// watex (WebAssign's HTML math) draws brackets, radicals and vector arrows as
// black GIFs sized by inline em values and positioned by its CSS. They render
// wrong without that CSS and poorly on dark backgrounds, so rebuild them as
// real glyphs that inherit color and scale with the text.
// ---------------------------------------------------------------------------

const DELIMS: Record<string, [string, string]> = {
  angle: ['⟨', '⟩'], paren: ['(', ')'], bracket: ['[', ']'], brace: ['{', '}'],
  bar: ['|', '|'], vert: ['|', '|'], dblbar: ['‖', '‖'], floor: ['⌊', '⌋'], ceil: ['⌈', '⌉'],
};

/** Height in em from an inline style like "height: 2.279em". */
const emHeight = (el: Element | null) => {
  const m = /height:\s*([\d.]+)em/.exec(el?.getAttribute('style') ?? '');
  return m ? Number(m[1]) : null;
};

function rewriteWatex(root: HTMLElement, doc: Document) {
  // ⟨ ( [ { | delimiters: <table class="watexparenleft"><td><img src=".../leftangle0.gif">
  root.querySelectorAll('table.watexparenleft, table.watexparenright').forEach((t) => {
    const img = t.querySelector('img');
    const m = /(left|right)(angle|paren|bracket|brace|dblbar|bar|vert|floor|ceil)\d*\w*\.gif/i.exec(img?.getAttribute('src') ?? '');
    if (!m) return;
    const h = emHeight(img) ?? 1.3;
    const span = doc.createElement('span');
    span.className = `wx-delim wx-${m[1].toLowerCase()}`;
    span.textContent = DELIMS[m[2].toLowerCase()][m[1].toLowerCase() === 'left' ? 0 : 1];
    // A delimiter glyph is ~1.15em tall at font-size 1em.
    span.style.fontSize = `${Math.max(1, h / 1.15).toFixed(2)}em`;
    t.replaceWith(span);
  });

  // √: <table class="watexsqrt"><td class="watexsqrtradical"><img sqrt1a.gif></td><td class="watexsqrtradicand">…</td>
  root.querySelectorAll('table.watexsqrt').forEach((t) => {
    const radicand = t.querySelector('.watexsqrtradicandcontent') ?? t.querySelector('.watexsqrtradicand');
    if (!radicand) return;
    const h = emHeight(t.querySelector('.watexsqrtradical img')) ?? 1.25;
    const wrap = doc.createElement('span');
    wrap.className = 'wx-sqrt';
    const rad = doc.createElement('span');
    rad.className = 'wx-rad';
    rad.textContent = '√';
    rad.style.fontSize = `${Math.max(1, h / 1.1).toFixed(2)}em`;
    const body = doc.createElement('span');
    body.className = 'wx-radicand';
    while (radicand.firstChild) body.appendChild(radicand.firstChild);
    wrap.append(rad, body);
    t.replaceWith(wrap);
  });

  // Vector arrow over letters: <span class="watexoverrightarrowcomplex"><span content>AB</span><img arrowhead>
  root.querySelectorAll('.watexoverrightarrowcomplex').forEach((c) => {
    c.querySelectorAll('img').forEach((i) => i.remove());
    c.classList.add('wx-overarrow');
    c.removeAttribute('style');
  });
}

/**
 * Closed/answered MathType boxes stay in the markup as disabled editors whose
 * rendered answer sits in .mtAnswer. Show just the answer.
 */
function staticMathAnswers(root: HTMLElement, doc: Document) {
  root.querySelectorAll('.mathtype-wrapper, .mathtype').forEach((w) => {
    if (!w.isConnected) return;
    const wrap = w.closest('.mathtype-wrapper') ?? w;
    const answer = wrap.querySelector('.mtAnswer math, .mtAnswer');
    const span = doc.createElement('span');
    span.className = 'wa-static';
    if (answer) span.appendChild(answer.tagName.toLowerCase() === 'math' ? answer : answer.cloneNode(true));
    wrap.replaceWith(span);
  });
}

/**
 * Closed questions keep their answers as disabled radios/checkboxes, often
 * wrapped in the grading mark (<span class="waMark mCorrect">). Show them as
 * read-only markers, with the chosen label colored by that grade.
 */
function staticChoices(root: HTMLElement, doc: Document) {
  root.querySelectorAll('.badgeWrap').forEach((e) => e.remove());
  root.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]').forEach((inp) => {
    const mark = inp.closest('.waMark');
    const grade = mark ? Array.from(mark.classList).find((c) => /^m[A-Z]/.test(c))?.slice(1).toLowerCase() : undefined;
    const chosen = inp.hasAttribute('checked');
    const marker = doc.createElement('span');
    marker.className = `static-opt ${inp.type}${chosen ? ' on' : ''}${grade && chosen ? ` grade-${grade}` : ''}`;
    if (chosen && inp.id) {
      root.querySelector(`label[for="${CSS.escape(inp.id)}"]`)?.classList.add('static-chosen', ...(grade ? [`grade-${grade}`] : []));
    }
    inp.replaceWith(marker);
  });
  root.querySelectorAll('.waMark, .waMarkWrap').forEach((m) => m.replaceWith(...Array.from(m.childNodes)));
}

export function sanitizeQuestionHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html');
  const root = doc.getElementById('root')!;

  staticChoices(root, doc);
  root.querySelectorAll(DROP).forEach((e) => e.remove());
  staticMathAnswers(root, doc);
  rewriteWatex(root, doc);

  root.querySelectorAll<HTMLElement>('*').forEach((el) => {
    for (const a of Array.from(el.attributes)) {
      const n = a.name.toLowerCase();
      if (n.startsWith('on') || n === 'srcset' || n === 'target'
          || (URL_ATTRS.includes(n) && !/^(https?:|data:image\/)/i.test(a.value.trim()))) {
        el.removeAttribute(a.name);
      }
    }
    // An image whose URL we can't load would only show its alt text.
    if (el.tagName === 'IMG' && !el.getAttribute('src')) {
      el.remove();
      return;
    }
    if (el.tagName === 'A') {
      const span = doc.createElement('span');
      while (el.firstChild) span.appendChild(el.firstChild);
      el.replaceWith(span);
      return;
    }
    // Dark-on-dark fixes: inline black text and white backgrounds.
    if (el.style) {
      if (el.style.color && dark(el.style.color)) el.style.removeProperty('color');
      if (el.style.backgroundColor && light(el.style.backgroundColor)) el.style.removeProperty('background-color');
      if (el.style.borderColor && dark(el.style.borderColor)) el.style.borderColor = 'currentColor';
    }
    const fontColor = el.getAttribute('color');
    if (fontColor && dark(fontColor)) el.removeAttribute('color');
    const bg = el.getAttribute('bgcolor');
    if (bg && light(bg)) el.removeAttribute('bgcolor');
  });

  // Frame every content image (figures, graphs, image choices); lib/images.ts
  // then decides per image whether it needs dark-mode inversion.
  root.querySelectorAll('img').forEach((img) => {
    if (/\/watex\/img\//.test(img.getAttribute('src') ?? '') || img.closest('.qfig')) return;
    const fig = doc.createElement('span');
    fig.className = 'qfig';
    img.replaceWith(fig);
    fig.appendChild(img);
  });

  // MathML Core in WebView2 lacks <mfenced>; rewrite each formula.
  root.querySelectorAll('math').forEach((m) => {
    const html2 = renderable(new XMLSerializer().serializeToString(m));
    if (!html2) return;
    const tpl = doc.createElement('template');
    tpl.innerHTML = html2;
    m.replaceWith(tpl.content);
  });

  return root.innerHTML;
}
