/**
 * A printable worksheet from a WebAssign assignment.
 *
 * Exports used to be built as LaTeX and handed to pdflatex or Tectonic, which
 * meant a student could not save a worksheet without installing a TeX
 * distribution first. They are now built as HTML and laid out by Salem's own
 * Python (`src-tauri/python/salem_pdf.py`), which the app already carries for
 * reading PDFs and drawing figures.
 *
 * The hard part — working out what a WebAssign question is actually asking,
 * which boxes belong to which part, and what the options are — is unchanged
 * and still lives in `lib/latex`. This only decides how that comes out on a
 * page, and HTML is a far shorter trip from the source than LaTeX was: the
 * questions are HTML to begin with.
 */

import { sanitizeQuestionHtml } from './sanitize';
import {
  collapse, cssSize, isFigure, mathmlToLatex, partsOf, planQuestion, textBody,
  type Ctx, type ExportImage, type ExportMeta, type Part, type Plan,
} from './latex';
import { escapeHtml } from './mdPrint';
import type { Assignment, Question } from '../types';

export type WorksheetExport = { html: string; images: ExportImage[] };

/** Tags that carry nothing a printed sheet wants. */
const SKIP = new Set(['script', 'style', 'noscript', 'button', 'input', 'select', 'textarea', 'svg', 'iframe', 'head']);
/** Tags that pass through with their meaning intact. */
const KEEP = new Set(['b', 'strong', 'i', 'em', 'u', 'sub', 'sup', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'ul', 'ol', 'li', 'p', 'div', 'span', 'br', 'hr', 'blockquote', 'pre', 'code']);
/** What a WebAssign answer box becomes: a rule to write on. */
const BOX_HEIGHT: Record<string, string> = {
  math: '2.4em', text: '2em', number: '2em', choice: '2em', checkboxes: '2em',
  multiselect: '2em', essay: '6em', unsupported: '2em', static: '2em',
};

const parse = (html: string): Element => {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  return doc.body.firstElementChild as Element;
};

function emit(node: Node, ctx: Ctx): string {
  if (node.nodeType === 3) return escapeHtml(collapse(node.nodeValue ?? ''));
  if (node.nodeType !== 1) return '';
  const el = node as Element;
  const tag = el.localName;
  if (SKIP.has(tag)) return '';

  // Maths goes over as LaTeX in the renderer's delimiters; it draws it.
  if (tag === 'math') {
    const tex = mathmlToLatex(new XMLSerializer().serializeToString(el));
    return tex ? `\\(${tex}\\)` : '';
  }
  if (tag === 'img') return figure(el, ctx);
  if (tag === 'br') return '<br />';
  if (tag === 'hr') return '<hr />';

  const inner = Array.from(el.childNodes).map((c) => emit(c, ctx)).join('');
  if (!KEEP.has(tag)) return inner;
  if (tag === 'div' || tag === 'span') {
    // A bare wrapper adds nothing on paper; a block one becomes a paragraph.
    return /display\s*:\s*block/i.test(el.getAttribute('style') ?? '') ? `<p>${inner}</p>` : inner;
  }
  return inner.trim() ? `<${tag}>${inner}</${tag}>` : '';
}

/**
 * A figure, at roughly the size the app shows it.
 *
 * WebAssign gives pixel sizes for a 13px column; the sheet is 10.5pt, so a
 * pixel is about 0.85pt. An image with no stated size keeps its own.
 */
function figure(el: Element, ctx: Ctx): string {
  const file = ctx.imgRef(el.getAttribute('src') ?? '', collapse(el.getAttribute('alt') ?? '').trim());
  if (!file) return '';
  const { w, h } = cssSize(el);
  const attrs = [`src="${file}"`];
  if (w) attrs.push(`width="${Math.round(w * 0.85)}"`);
  if (h) attrs.push(`height="${Math.round(h * 0.85)}"`);
  // An image inside an option belongs to that choice, not to the question.
  const inOption = !!el.closest('.wa-opt-label, label');
  return inOption ? `<img ${attrs.join(' ')} />` : `<p class="figure"><img ${attrs.join(' ')} /></p>`;
}

/** Where the student writes the answer. */
function answerArea(parts: Part[]): string {
  if (parts.every((p) => p.inline)) return '';
  const rows: string[] = ['<p class="answers-head">Answers</p>'];
  for (const part of parts) {
    const marks = part.marks != null ? `<span class="marks">[${part.marks}]</span>` : '';
    if (part.inline) {
      rows.push(`<p class="answer-note"><b>${escapeHtml(part.label)}</b> ticked in the question above ${marks}</p>`);
      continue;
    }
    if (part.options?.length) {
      // Chosen from a list: tick one, rather than copying the wording out.
      const boxes = part.options
        .map((o, i) => `<td class="opt">${part.kind === 'checkboxes' ? '☐' : '◯'} ${i + 1}. ${o}</td>`)
        .join('');
      for (let i = 0; i < part.subs; i++) {
        const label = part.subs > 1 ? `${part.label}${i + 1}` : part.label;
        rows.push(`<p class="answer-note"><b>${escapeHtml(label)}</b> ${i === 0 ? marks : ''}</p><table class="opts"><tr>${boxes}</tr></table>`);
      }
      continue;
    }
    const height = BOX_HEIGHT[part.kind] ?? '2.1em';
    for (let i = 0; i < part.subs; i++) {
      const label = part.subs > 1 ? `${part.label}${i + 1}` : part.label;
      rows.push(
        `<table class="answer-box"><tr>`
        + `<td class="answer-label">${escapeHtml(label)}</td>`
        + `<td class="answer-space" style="height: ${height};"></td>`
        + `<td class="answer-marks">${i === 0 ? marks : ''}</td>`
        + `</tr></table>`,
      );
    }
  }
  return rows.join('\n');
}

/** The answers, for whoever is marking. */
function markScheme(rows: { q: number; parts: Part[] }[]): string {
  const withAnswers = rows.filter((r) => r.parts.some((p) => p.answer));
  if (!withAnswers.length) return '';
  const lines = withAnswers.map((row) => {
    const answers = row.parts
      .filter((p) => p.answer)
      .map((p) => `<b>${escapeHtml(p.label)}</b> ${p.answer}`)
      .join(' &nbsp;·&nbsp; ');
    return `<tr><td class="scheme-q">${row.q}</td><td>${answers}</td></tr>`;
  });
  return `<h2>Answers</h2><table class="scheme">${lines.join('')}</table>`;
}

export function assignmentToWorksheet(a: Assignment, meta: ExportMeta = {}): WorksheetExport {
  const images: ExportImage[] = [];
  const byUrl = new Map<string, ExportImage>();
  const imgRef = (url: string, alt: string): string | null => {
    if (!isFigure(url)) return null;
    let found = byUrl.get(url);
    if (!found) {
      found = { file: `figure-${byUrl.size + 1}.png`, url, alt };
      byUrl.set(url, found);
      images.push(found);
    }
    if (!found.alt && alt) found.alt = alt;
    return found.file;
  };

  const scheme: { q: number; parts: Part[] }[] = [];
  const blocks = a.questions.map((q: Question) => {
    const root = q.html ? parse(sanitizeQuestionHtml(q.html)) : null;
    const plan: Plan = root
      ? planQuestion(root, q)
      : { optNo: new Map(), staticLabels: [], synthetic: [], subs: new Map(), inlineOpts: new Set(), groupLabel: new Map() };
    const ctx: Ctx = { plan, boxes: q.boxes, seen: { statics: 0 }, inline: 0, imgRef };
    const body = root ? Array.from(root.childNodes).map((c) => emit(c, ctx)).join('') : escapeHtml(textBody(q));
    const parts = partsOf(q, plan, ctx);
    scheme.push({ q: q.number, parts });

    const marks = q.total != null ? `<span class="marks">[${q.total} mark${q.total === 1 ? '' : 's'}]</span>` : '';
    return [
      `<div class="question">`,
      `<h2>Question ${q.number} ${marks}</h2>`,
      body || '<p class="muted">(no printable content)</p>',
      answerArea(parts),
      `</div>`,
    ].join('\n');
  });

  const header: string[] = [];
  if (meta.nameFields !== false) {
    header.push('<table class="namefields"><tr><td>Name</td><td class="rule"></td><td>Class</td><td class="rule"></td><td>Date</td><td class="rule"></td></tr></table>');
  }

  const html = [...header, ...blocks, markScheme(scheme)].filter(Boolean).join('\n');
  return { html, images };
}

/** The subtitle line: course, section, term. */
export const worksheetSubtitle = (meta: ExportMeta): string =>
  [meta.course, meta.section && `Section ${meta.section}`, meta.term].filter(Boolean).join(' · ');
