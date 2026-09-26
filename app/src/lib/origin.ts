import type { GenSource, Page } from './deckPlan';
import type { QuestionSource, SourceHit, SourceKind } from '../study/api';

/** One page (or slide, section, part) of a source that went into making something. */
export type ReadPage = { sourceId: number; title: string; kind: SourceKind; unit: number };

/**
 * What a generator really put in front of the model: the pages it read and the notes it was
 * given. Not the same as what the student ticked - a long selection is sampled down, instructions
 * can narrow it to a few pages, and going page by page leaves the notes out.
 */
export type Read = { pages: ReadPage[]; notes: { id: number; title: string }[] };

export type OriginSource = { sourceId: number; title: string; kind: SourceKind; units: [number, number][] };

/** What a deck, quiz or note was made from, kept with it when it is saved. */
export type Origin =
  | { kind: 'sources'; sources: OriginSource[]; notes: { id: number; title: string }[]; focus: string }
  | { kind: 'topic'; prompt: string }
  | { kind: 'chat'; threadId: number | null; title: string; messages: number }
  | { kind: 'mistakes'; count: number; quiz?: string };

export const NOTHING_READ: Read = { pages: [], notes: [] };

export const unitWord = (kind: SourceKind) => (kind === 'pdf' ? 'page' : kind === 'slides' ? 'slide' : kind === 'youtube' ? 'part' : 'section');

type Span = Pick<SourceHit, 'sourceId' | 'sourceTitle' | 'kind' | 'unitFrom' | 'unitTo'>;

export const pagesOf = (hits: Span[]): ReadPage[] => hits.flatMap((h) => Array.from(
  { length: Math.max(1, h.unitTo - h.unitFrom + 1) },
  (_, i) => ({ sourceId: h.sourceId, title: h.sourceTitle, kind: h.kind, unit: h.unitFrom + i }),
));

export const pagesOfWalk = (pages: Page[]): ReadPage[] =>
  pages.map((p) => ({ sourceId: p.sourceId, title: p.sourceTitle, kind: p.kind, unit: p.ord }));

/** Everything a source-based request hands the model when nothing is trimmed along the way. */
export const readOf = (src: GenSource): Read => (src.kind === 'sources'
  ? { pages: pagesOf(src.hits), notes: (src.notes ?? []).map(({ id, title }) => ({ id, title })) }
  : NOTHING_READ);

/** A card's source_refs as stored: one reference, a list of them, or nothing usable. */
export function refsOf(value: unknown): QuestionSource[] {
  const list = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
  return list.filter((r): r is QuestionSource => !!r && typeof r.sourceId === 'number' && typeof r.title === 'string');
}

export function ranges(units: number[]): [number, number][] {
  const sorted = [...new Set(units.filter((u) => Number.isInteger(u) && u >= 0))].sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const u of sorted) {
    const last = out[out.length - 1];
    if (last && u === last[1] + 1) last[1] = u;
    else out.push([u, u]);
  }
  return out;
}

type Cited = (QuestionSource[] | null | undefined)[];

function grouped(pages: ReadPage[], refs: QuestionSource[], order: number[]): OriginSource[] {
  const by = new Map<number, { title: string; kind: SourceKind; units: number[] }>();
  const kinds = new Map(pages.map((p) => [p.sourceId, p.kind]));
  const add = (sourceId: number, title: string, kind: SourceKind, unit?: number) => {
    const s = by.get(sourceId) ?? { title, kind, units: [] };
    if (typeof unit === 'number') s.units.push(unit);
    by.set(sourceId, s);
  };
  for (const p of pages) if (p.sourceId > 0) add(p.sourceId, p.title, p.kind, p.unit);
  for (const r of refs) if (r.sourceId > 0) add(r.sourceId, r.title, kinds.get(r.sourceId) ?? 'file', r.unit);
  const rank = (id: number) => { const i = order.indexOf(id); return i < 0 ? order.length : i; };
  return [...by.entries()]
    .map(([sourceId, s], i) => ({ i, source: { sourceId, title: s.title, kind: s.kind, units: ranges(s.units) } }))
    .sort((a, b) => rank(a.source.sourceId) - rank(b.source.sourceId) || a.i - b.i)
    .map((x) => x.source);
}

/** A note read page by page, or cited by a question, carries a negative id so it is never taken for a source. */
function notesOf(read: Read, refs: QuestionSource[]): { id: number; title: string }[] {
  const out = new Map(read.notes.map((n) => [n.id, n]));
  const add = (id: number, title: string) => { if (id < 0 && !out.has(-id)) out.set(-id, { id: -id, title }); };
  for (const p of read.pages) add(p.sourceId, p.title);
  for (const r of refs) add(r.sourceId, r.title);
  return [...out.values()];
}

/**
 * The record kept with a new deck, quiz or note: the request it came from, with the pages that
 * were read and any pages its items cite on top (a refill round can reach past the sample).
 */
export function originOf(src: GenSource, read: Read, cited: Cited = []): Origin {
  if (src.kind === 'topic') return { kind: 'topic', prompt: src.prompt.trim() };
  if (src.kind === 'chat') {
    return {
      kind: 'chat',
      threadId: src.thread?.id ?? null,
      title: src.thread?.title ?? '',
      messages: src.messages.filter((m) => m.role === 'user' || m.role === 'assistant').length,
    };
  }
  if (src.kind === 'mistakes') return { kind: 'mistakes', count: src.items.length };
  const refs = cited.flatMap((c) => c ?? []);
  const order = [...new Set(src.hits.map((h) => h.sourceId))];
  return { kind: 'sources', sources: grouped(read.pages, refs, order), notes: notesOf(read, refs), focus: src.focus.trim() };
}

/** For a deck or quiz saved before origins were kept: the sources its items cite, or nothing. */
export function citedOrigin(cited: Cited): Origin | null {
  const refs = cited.flatMap((c) => c ?? []);
  if (!refs.length) return null;
  return { kind: 'sources', sources: grouped([], refs, []), notes: notesOf(NOTHING_READ, refs), focus: '' };
}

/** How many items cite each source, counting an item once however many of its pages it cites. */
export function citeCounts(cited: Cited): Map<number, number> {
  const out = new Map<number, number>();
  for (const refs of cited) {
    for (const id of new Set((refs ?? []).map((r) => r.sourceId))) out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}

/** "pages 3–7, 12", "all 24 slides", "12 of 30 parts"; empty when there is nothing worth saying. */
export function coverage(units: [number, number][], kind: SourceKind, total?: number): string {
  const count = units.reduce((n, [a, b]) => n + b - a + 1, 0);
  if (!count) return '';
  const noun = unitWord(kind);
  const many = (n: number) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  if (total && count >= total) return total === 1 ? '' : `all ${many(total)}`;
  if ((kind === 'pdf' || kind === 'slides') && units.length <= 3) {
    return `${noun}${count === 1 ? '' : 's'} ${units.map(([a, b]) => (a === b ? `${a + 1}` : `${a + 1}–${b + 1}`)).join(', ')}`;
  }
  return total ? `${count} of ${many(total)}` : many(count);
}

const KINDS: SourceKind[] = ['pdf', 'slides', 'image', 'text', 'youtube', 'file'];
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** An origin read back from the database, or null when there is none or it does not make sense. */
export function asOrigin(value: unknown): Origin | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.kind === 'topic') return { kind: 'topic', prompt: str(v.prompt) };
  if (v.kind === 'chat') return { kind: 'chat', threadId: num(v.threadId), title: str(v.title), messages: num(v.messages) ?? 0 };
  if (v.kind === 'mistakes') return { kind: 'mistakes', count: num(v.count) ?? 0, ...(str(v.quiz) ? { quiz: str(v.quiz) } : {}) };
  if (v.kind !== 'sources') return null;
  const sources = (Array.isArray(v.sources) ? v.sources : []).flatMap((s): OriginSource[] => {
    const id = num(s?.sourceId);
    if (id === null) return [];
    const units = (Array.isArray(s.units) ? s.units : [])
      .filter((u: unknown): u is [number, number] => Array.isArray(u) && u.length === 2 && u.every((x) => num(x) !== null));
    return [{ sourceId: id, title: str(s.title), kind: KINDS.includes(s.kind) ? s.kind : 'file', units }];
  });
  const notes = (Array.isArray(v.notes) ? v.notes : []).flatMap((n) => {
    const id = num(n?.id);
    return id === null ? [] : [{ id, title: str(n.title) }];
  });
  return { kind: 'sources', sources, notes, focus: str(v.focus) };
}
