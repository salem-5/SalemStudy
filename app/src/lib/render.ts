import { EMPTY, toMathML, toText } from './mathpad.js';

// WebView2/Chromium renders MathML Core, which dropped <mfenced> and <maction>.
// Rewrite those into plain <mrow>/<mo> so previews look like the pad.
export function renderable(mathml: string): string {
  const doc = new DOMParser().parseFromString(mathml || EMPTY, 'application/xml');
  if (doc.querySelector('parsererror')) return '';
  const ns = doc.documentElement.namespaceURI;
  const mk = (tag: string, text?: string) => {
    const el = doc.createElementNS(ns, tag);
    if (text !== undefined) el.textContent = text;
    return el;
  };
  doc.querySelectorAll('maction').forEach((a) => a.replaceWith(...Array.from(a.children).slice(0, 1)));
  // Innermost first so nested fences are handled before their parents move.
  Array.from(doc.querySelectorAll('mfenced')).reverse().forEach((f) => {
    const open = f.hasAttribute('open') ? f.getAttribute('open')! : '(';
    const close = f.hasAttribute('close') ? f.getAttribute('close')! : ')';
    const seps = f.hasAttribute('separators') ? f.getAttribute('separators')!.replace(/\s/g, '') : ',';
    const row = mk('mrow');
    const o = mk('mo', open === '<' ? '⟨' : open);
    o.setAttribute('stretchy', 'true');
    row.appendChild(o);
    Array.from(f.children).forEach((c, i, all) => {
      row.appendChild(c);
      if (i < all.length - 1 && seps) row.appendChild(mk('mo', seps[Math.min(i, seps.length - 1)]));
    });
    const c = mk('mo', close === '>' ? '⟩' : close);
    c.setAttribute('stretchy', 'true');
    row.appendChild(c);
    f.replaceWith(row);
  });
  return new XMLSerializer().serializeToString(doc);
}

export type Preview = { mathml: string; html: string; error: string | null };

export function previewExpr(expr: string): Preview {
  if (!expr.trim()) return { mathml: EMPTY, html: '', error: null };
  try {
    const mathml = toMathML(expr);
    return { mathml, html: renderable(mathml), error: null };
  } catch (e) {
    return { mathml: '', html: '', error: e instanceof Error ? e.message : String(e) };
  }
}

/** Canonical text for comparing a typed expression with the server's MathML. */
export function canonical(expr: string): string | null {
  if (!expr.trim()) return '';
  try {
    return toText(toMathML(expr)).replace(/\s+/g, '');
  } catch {
    return null;
  }
}

export const canonicalMathML = (mathml: string) => toText(mathml).replace(/\s+/g, '');
