import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Marked } from 'marked';
import TurndownService from 'turndown';

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

export const onPadChanged = (fn: (c: PadChange) => void) => listen<PadChange>('pad://changed', (e) => fn(e.payload));

const md = new Marked({ gfm: true, breaks: true });

export function markdownToHtml(markdown: string): string {
  const withMath = markdown
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex: string) => `<div data-type="block-math" data-latex="${escAttr(tex.trim())}"></div>`)
    .replace(/(?<![\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\w)/g, (_, tex: string) => `<span data-type="inline-math" data-latex="${escAttr(tex)}"></span>`);
  let html = md.parse(withMath, { async: false }) as string;
  html = html.replace(/<ul>\s*(<li><input[^>]*type="checkbox"[\s\S]*?)<\/ul>/g, (_, items: string) =>
    `<ul data-type="taskList">${items.replace(/<li><input([^>]*)>\s*/g, (_m, attrs: string) =>
      `<li data-type="taskItem" data-checked="${/checked/.test(attrs) ? 'true' : 'false'}">`)}</ul>`);
  return html;
}

const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const mathOf = (node: Node): string | null => {
  const el = node as HTMLElement;
  const type = el.getAttribute?.('data-type');
  if (type === 'inline-math') return ` $${el.getAttribute('data-latex') ?? ''}$ `;
  if (type === 'block-math') return `\n\n$$${el.getAttribute('data-latex') ?? ''}$$\n\n`;
  return null;
};

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
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

export const htmlToMarkdown = (html: string): string =>
  turndown.turndown(html || '')
    .replace(/ {2,}\$/g, ' $').replace(/\$ {2,}/g, '$ ')
    .replace(/(^|\n|\() \$/g, '$1$').replace(/\$ ([.,;:!?)]|$)/gm, '$$$1');

export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const blocks = doc.body.querySelectorAll('p, h1, h2, h3, h4, li, blockquote, pre, div[data-type="block-math"]');
  blocks.forEach((b) => b.append('\n'));
  doc.body.querySelectorAll('[data-latex]').forEach((m) => { m.textContent = m.getAttribute('data-latex') ?? ''; });
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}
