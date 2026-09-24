import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Marked } from 'marked';
import TurndownService from 'turndown';

/**
 * Notes — the student's own notes app (`pad.rs` on the other side).
 *
 * Notes are HTML from the editor, with a plain-text copy the app titles,
 * previews and searches by. The assistant reads and writes them as Markdown,
 * which is what it is fluent in; the conversion both ways is here.
 */

export type PadFolder = { id: number; name: string; count: number };
export type PadOverview = { folders: PadFolder[]; all: number; unfiled: number; deleted: number };
export type PadNoteMeta = {
  id: number;
  folderId: number | null;
  title: string;
  snippet: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};
export type PadNote = PadNoteMeta & { html: string; text: string };
export type PadScope = 'all' | 'unfiled' | 'folder' | 'deleted';

/** Which page made a change, so its own edits do not reload its editor. */
export const PAD_SOURCE = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? `editor:${crypto.randomUUID()}` : 'editor';

export const padApi = {
  overview: () => invoke<PadOverview>('pad_overview'),
  notes: (scope: PadScope, folder?: number | null) => invoke<PadNoteMeta[]>('pad_notes', { scope, folder: folder ?? null }),
  search: (query: string) => invoke<PadNoteMeta[]>('pad_search', { query }),
  note: (id: number) => invoke<PadNote>('pad_note', { id }),
  createFolder: (name: string, by?: string) => invoke<PadFolder>('pad_folder_create', { name, by: by ?? null }),
  renameFolder: (id: number, name: string, by?: string) => invoke<void>('pad_folder_rename', { id, name, by: by ?? null }),
  deleteFolder: (id: number, by?: string) => invoke<void>('pad_folder_delete', { id, by: by ?? null }),
  create: (folder: number | null, html: string, text: string, by?: string) =>
    invoke<PadNote>('pad_note_create', { folder, html, text, by: by ?? null }),
  save: (id: number, html: string, text: string, by?: string) => invoke<number>('pad_note_save', { id, html, text, by: by ?? null }),
  move: (id: number, folder: number | null, by?: string) => invoke<void>('pad_note_move', { id, folder, by: by ?? null }),
  pin: (id: number, pinned: boolean, by?: string) => invoke<void>('pad_note_pin', { id, pinned, by: by ?? null }),
  remove: (id: number, forever = false, by?: string) => invoke<void>('pad_note_delete', { id, forever, by: by ?? null }),
  restore: (id: number, by?: string) => invoke<void>('pad_note_restore', { id, by: by ?? null }),
  emptyDeleted: (by?: string) => invoke<number>('pad_empty_deleted', { by: by ?? null }),
};

export type PadChange = { what: 'note' | 'folder'; id: number | null; by: string | null };

/** Hear every change to notes, from this page, another, or the assistant. */
export const onPadChanged = (fn: (c: PadChange) => void) => listen<PadChange>('pad://changed', (e) => fn(e.payload));

// ------------------------------------------------------------ conversions

const md = new Marked({ gfm: true, breaks: true });

/**
 * Markdown (as the assistant writes it) → the editor's HTML.
 *
 * `- [ ]` task items become the editor's checklist, and `$…$` maths the
 * editor's inline maths, so what the assistant writes looks like what the
 * student would have typed.
 */
export function markdownToHtml(markdown: string): string {
  const withMath = markdown
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex: string) => `<div data-type="block-math" data-latex="${escAttr(tex.trim())}"></div>`)
    .replace(/(?<![\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\w)/g, (_, tex: string) => `<span data-type="inline-math" data-latex="${escAttr(tex)}"></span>`);
  let html = md.parse(withMath, { async: false }) as string;
  // GFM task lists → Tiptap's taskList/taskItem.
  html = html.replace(/<ul>\s*(<li><input[^>]*type="checkbox"[\s\S]*?)<\/ul>/g, (_, items: string) =>
    `<ul data-type="taskList">${items.replace(/<li><input([^>]*)>\s*/g, (_m, attrs: string) =>
      `<li data-type="taskItem" data-checked="${/checked/.test(attrs) ? 'true' : 'false'}">`)}</ul>`);
  return html;
}

const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The maths the editor keeps in an attribute, as Markdown. */
const mathOf = (node: Node): string | null => {
  const el = node as HTMLElement;
  const type = el.getAttribute?.('data-type');
  // A space before it: Turndown trims the one the text had, next to a blank node.
  if (type === 'inline-math') return ` $${el.getAttribute('data-latex') ?? ''}$ `;
  if (type === 'block-math') return `\n\n$$${el.getAttribute('data-latex') ?? ''}$$\n\n`;
  return null;
};

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  // A maths node has no text of its own (the formula is an attribute), so
  // Turndown counts it as blank and drops it before any rule sees it.
  blankReplacement: (_content, node) => mathOf(node as Node) ?? ((node as HTMLElement).nodeName === 'P' || (node as { isBlock?: boolean }).isBlock ? '\n\n' : ''),
});
turndown.addRule('taskItem', {
  filter: (node) => node.nodeName === 'LI' && (node as HTMLElement).getAttribute('data-type') === 'taskItem',
  replacement: (content, node) => `- [${(node as HTMLElement).getAttribute('data-checked') === 'true' ? 'x' : ' '}] ${content.trim()}\n`,
});
turndown.addRule('inlineMath', {
  filter: (node) => (node as HTMLElement).getAttribute?.('data-type') === 'inline-math',
  replacement: (_c, node) => `$${(node as HTMLElement).getAttribute('data-latex') ?? ''}$`,
});
turndown.addRule('blockMath', {
  filter: (node) => (node as HTMLElement).getAttribute?.('data-type') === 'block-math',
  replacement: (_c, node) => `\n$$${(node as HTMLElement).getAttribute('data-latex') ?? ''}$$\n`,
});
turndown.addRule('highlight', { filter: 'mark', replacement: (c) => `==${c}==` });

/** The editor's HTML → Markdown, for the assistant to read. */
export const htmlToMarkdown = (html: string): string =>
  turndown.turndown(html || '')
    // Maths is written with a space either side (Turndown trims the text's
    // own next to it); tidy the doubles and the ones before punctuation.
    .replace(/ {2,}\$/g, ' $').replace(/\$ {2,}/g, '$ ')
    .replace(/(^|\n|\() \$/g, '$1$').replace(/\$ ([.,;:!?)]|$)/gm, '$$$1');

/** Plain text of some HTML (titles, previews, search), in the browser. */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const blocks = doc.body.querySelectorAll('p, h1, h2, h3, h4, li, blockquote, pre, div[data-type="block-math"]');
  blocks.forEach((b) => b.append('\n'));
  doc.body.querySelectorAll('[data-latex]').forEach((m) => { m.textContent = m.getAttribute('data-latex') ?? ''; });
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}
