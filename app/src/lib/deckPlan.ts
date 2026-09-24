import type { Difficulty, SourceHit, SourceKind } from '../study/api';

export type CardSize = 'fewer' | 'standard' | 'more';

export type CardOptions = {
  size?: CardSize;
  difficulty?: Difficulty | 'mixed';
};

export type GenSource =
  | { kind: 'topic'; prompt: string }
  | { kind: 'chat'; messages: { role: string; content: string }[] }
  | { kind: 'mistakes'; items: { prompt: string; answer: string; explanation: string; topic: string }[] }
  | { kind: 'sources'; hits: SourceHit[]; notes?: { id: number; title: string; content: string }[]; focus: string };

export const MAX_ITEMS = 96;

const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};

function roman(text: string): number | null {
  const t = text.toUpperCase();
  if (!/^[IVXL]+$/.test(t)) return null;
  const value: Record<string, number> = { I: 1, V: 5, X: 10, L: 50 };
  let total = 0;
  for (let i = 0; i < t.length; i++) {
    const here = value[t[i]];
    const next = value[t[i + 1]] ?? 0;
    total += here < next ? -here : here;
  }
  return total > 0 && total < 60 ? total : null;
}

const KEYWORD = String.raw`(?:lecture|lect|lec|l|week|wk|w|chapter|chap|ch|part|pt|session|sess|unit|module|mod|topic|section|sec|day|class|lesson|les|tutorial|tut|lab|practical|seminar|block|set|no\.?|#)`;
const NUMBER = String.raw`(\d{1,3}|[ivxl]{1,6}|[a-z]+)`;

export function ordinalOf(title: string): number | null {
  const t = title.trim();
  const keyed = new RegExp(String.raw`(?:^|[^a-z])${KEYWORD}[\s._:-]*${NUMBER}(?![a-z0-9])`, 'gi');
  for (const match of t.matchAll(keyed)) {
    const raw = match[1].toLowerCase();
    const n = /^\d+$/.test(raw) ? Number(raw) : WORDS[raw] ?? roman(raw);
    if (n !== null && n !== undefined) return n;
  }
  const leading = /^(\d{1,3})(?:[\s._:)\-]|$)/.exec(t);
  if (leading) return Number(leading[1]);
  return null;
}

export function readingOrder<T extends { title: string; createdAt: number }>(sources: T[]): T[] {
  return sources
    .map((s, i) => ({ s, i, n: ordinalOf(s.title) }))
    .sort((a, b) => {
      if (a.n !== null && b.n !== null && a.n !== b.n) return a.n - b.n;
      if (a.n !== null && b.n === null) return -1;
      if (a.n === null && b.n !== null) return 1;
      return a.s.createdAt - b.s.createdAt || a.i - b.i;
    })
    .map((x) => x.s);
}

export function applyOrder<T extends { id: number; title: string; createdAt: number }>(sources: T[], saved: number[] | undefined): T[] {
  const natural = readingOrder(sources);
  if (!saved?.length) return natural;
  const byId = new Map(sources.map((s) => [s.id, s]));
  const kept = saved.map((id) => byId.get(id)).filter((s): s is T => !!s);
  const seen = new Set(kept.map((s) => s.id));
  return [...kept, ...natural.filter((s) => !seen.has(s.id))];
}

export type Page = {
  sourceId: number;
  sourceTitle: string;
  kind: SourceKind;
  ord: number;
  label: string;
  text: string;
};

export type WalkSource = {
  id: number;
  title: string;
  kind: SourceKind;
  pages: Page[];
};

export type Window = {
  index: number;
  sourceId: number;
  sourceTitle: string;
  pages: Page[];
  from: string;
  to: string;
  chars: number;
};

export const WINDOW_CHARS = 6_000;

export const FAST_WINDOW_CHARS = 12_000;

const pageChars = (p: Page) => Math.max(40, p.text.trim().length);

const CHARS_PER_ITEM = 275;

export type SetOf = 'cards' | 'questions';

export const CARD_BANDS: Record<CardSize, [number, number]> = { fewer: [8, 32], standard: [32, 64], more: [64, 96] };

export const QUIZ_COUNT: Record<CardSize, number> = { fewer: 8, standard: 16, more: 28 };

export const CEILING: Record<CardSize, number> = { fewer: CARD_BANDS.fewer[1], standard: CARD_BANDS.standard[1], more: CARD_BANDS.more[1] };

export const ceilingOf = (size: CardSize, of: SetOf): number => (of === 'questions' ? QUIZ_COUNT[size] : CEILING[size]);

const FACTOR: Record<CardSize, number> = { fewer: 0.55, standard: 1, more: 1.5 };

const FULL = 150;

export function budgets(chars: number, limit?: number, of: SetOf = 'cards'): Record<CardSize, number> {
  if (limit && limit > 0) {
    const asked = Math.max(1, Math.min(Math.round(limit), MAX_ITEMS));
    return { fewer: asked, standard: asked, more: asked };
  }
  if (of === 'questions') return { ...QUIZ_COUNT };
  const natural = chars / CHARS_PER_ITEM;
  const f = Math.max(0, Math.min(1, natural / FULL));
  const at = (size: CardSize) => {
    const [lo, hi] = CARD_BANDS[size];
    const inBand = Math.round(lo + (hi - lo) * f);
    return Math.max(1, Math.min(inBand, Math.round(natural * FACTOR[size]) || 1));
  };
  const standard = at('standard');
  return {
    fewer: standard > 1 ? Math.min(at('fewer'), standard - 1) : 1,
    standard,
    more: Math.min(CEILING.more, Math.max(at('more'), standard + 1)),
  };
}

export const budgetFor = (windows: Pick<Window, 'chars'>[], size: CardSize, limit?: number, of: SetOf = 'cards'): number =>
  budgets(windows.reduce((n, w) => n + w.chars, 0), limit, of)[size];

export const isShrunk = (windows: Pick<Window, 'chars'>[], size: CardSize, limit?: number, fast = false, of: SetOf = 'cards'): boolean => {
  const natural = windows.reduce((n, w) => n + w.chars, 0) / CHARS_PER_ITEM;
  const as = writtenAs(size, fast);
  return budgetFor(windows, as, limit, of) < Math.round(natural * FACTOR[as]) - 1;
};

export const writtenAs = (size: CardSize, fast = false): CardSize => (size === 'fewer' && !fast ? 'standard' : size);

export const expectedItems = (w: Pick<Window, 'chars'>, all: Pick<Window, 'chars'>[], size: CardSize, limit?: number, fast = false, of: SetOf = 'cards'): number => {
  const total = all.reduce((n, x) => n + x.chars, 0) || 1;
  return Math.max(1, Math.round((w.chars / total) * budgetFor(all, writtenAs(size, fast), limit, of)));
};

export function planWalk(sources: WalkSource[], windowChars = WINDOW_CHARS): Window[] {
  const windows: Window[] = [];
  for (const source of sources) {
    let batch: Page[] = [];
    let used = 0;
    const flush = () => {
      if (!batch.length) return;
      windows.push({
        index: windows.length,
        sourceId: source.id,
        sourceTitle: source.title,
        pages: batch,
        from: batch[0].label,
        to: batch[batch.length - 1].label,
        chars: used,
      });
      batch = [];
      used = 0;
    };
    for (const page of [...source.pages].sort((a, b) => a.ord - b.ord)) {
      const size = pageChars(page);
      if (batch.length && used + size > windowChars) flush();
      batch.push(page);
      used += size;
    }
    flush();
  }
  return windows;
}

export const pageId = (p: Pick<Page, 'sourceId' | 'ord'>) => `${p.sourceId}:${p.ord}`;

const substance = (p: Page) => p.text.replace(/^\s*scanned page\s*$/gim, '').replace(/\s+/g, ' ').trim();

export function uncovered(window: Window, covered: Set<string>, minChars = 60): Window | null {
  const worth = (p: Page) => substance(p).length >= (p.ord === 0 ? 400 : minChars);
  const missing = window.pages.filter((p) => !covered.has(pageId(p)) && worth(p));
  if (!missing.length) return null;
  return {
    ...window,
    pages: missing,
    from: missing[0].label,
    to: missing[missing.length - 1].label,
    chars: missing.reduce((n, p) => n + pageChars(p), 0),
  };
}

export const pagesLabel = (w: Pick<Window, 'from' | 'to'>) => (w.from === w.to ? w.from : `${w.from}–${w.to.replace(/^[A-Za-z]+\s+/, '')}`);

export const renderSource = (source: WalkSource): string =>
  [
    `=== ${source.title} ===`,
    ...source.pages
      .filter((p) => p.text.trim())
      .map((p) => `--- ${p.label} ---\n${p.text.trim()}`),
  ].join('\n\n');

export const outlineSource = (source: WalkSource): string =>
  [
    `=== ${source.title} (outline) ===`,
    ...source.pages
      .filter((p) => p.text.trim())
      .map((p) => `${p.label}: ${p.text.trim().split('\n').find((l) => l.trim())?.trim().slice(0, 100) ?? ''}`),
  ].join('\n');

export const FULL_CONTEXT_CHARS = 180_000;

export function materialFor(sources: WalkSource[], sourceId: number): string {
  const total = sources.reduce((n, s) => n + s.pages.reduce((m, p) => m + p.text.length, 0), 0);
  if (total <= FULL_CONTEXT_CHARS) return sources.map(renderSource).join('\n\n');
  return sources.map((s) => (s.id === sourceId ? renderSource(s) : outlineSource(s))).join('\n\n');
}

export function fastMaterialFor(sources: WalkSource[], window: Pick<Window, 'sourceId' | 'sourceTitle' | 'pages'>): string {
  const outline = sources.map(outlineSource).join('\n\n');
  const own = renderSource({ id: window.sourceId, title: window.sourceTitle, kind: window.pages[0]?.kind ?? 'pdf', pages: window.pages });
  return `${outline}\n\n# In full: the pages of this pass\n\n${own}`;
}

export function sizeRule(size: CardSize, what: 'cards' | 'questions', shrunk = false): string {
  const one = what === 'cards' ? 'card' : 'question';
  const tag = `Mark every ${one}'s importance. core: a student who knew only the core ${one}s would still pass the exam on these pages — the definitions of the key terms, the main stages and classifications, the numbers that get examined, the classic features, causes and complications. detail: everything else worth knowing — the supporting facts, the second and third examples, the finer points. Be strict: on a typical page about a third to a half is core.`;
  if (size === 'more') {
    return `Everything a complete pass would write — a separate ${one} for every fact worth knowing on these pages — and then more for the same pages: ones that compare two things students confuse, connect a cause to its consequence, ask the student to apply a fact rather than repeat it, and cover the smaller details a complete pass might pass over. Keep them in the order of the pages.\n\n${tag}`;
  }
  if (shrunk) {
    return `Cover every page, and on each page every point a student is examined on — each key definition, stage, classification, number, cause, feature, complication — one ${one} per point. Fold the minor supporting facts into the ${one} they support instead of giving each its own. Do not summarise a page away and do not pad.\n\n${tag}`;
  }
  return `Every fact on these pages that is worth knowing — each definition, stage, number, cause, feature, investigation, complication — gets its own ${one}. A dense slide is several; a title or divider page is none. Do not summarise and do not skip anything; do not pad either.\n\n${tag}`;
}

export function coreOnly<T>(items: T[], pageOf: (item: T) => string, isCore: (item: T) => boolean): T[] {
  const hasCore = new Set(items.filter(isCore).map(pageOf));
  const first = new Set<string>();
  return items.filter((item) => {
    if (isCore(item)) return true;
    const page = pageOf(item);
    if (hasCore.has(page) || first.has(page)) return false;
    first.add(page);
    return true;
  });
}

export function balancedTrim<T>(items: T[], pageOf: (item: T) => string, max: number, isCore: (item: T) => boolean = () => true): T[] {
  if (items.length <= max) return items;
  const pages = new Map<string, number[]>();
  items.forEach((item, i) => {
    const key = pageOf(item);
    const list = pages.get(key);
    if (list) list.push(i); else pages.set(key, [i]);
  });
  const lists = [...pages.values()].map((l) => [...l.filter((i) => isCore(items[i])), ...l.filter((i) => !isCore(items[i]))]);
  const keep = new Set<number>();
  if (lists.length >= max) {
    for (let k = 0; k < max; k++) keep.add(lists[Math.floor((k * lists.length) / max)][0]);
    return items.filter((_, i) => keep.has(i));
  }
  const quota = lists.map(() => 1);
  const room = max - lists.length;
  const spare = lists.map((l) => l.length - 1);
  const total = spare.reduce((n, x) => n + x, 0);
  const share = spare.map((x) => (x * room) / total);
  share.forEach((x, p) => { quota[p] += Math.floor(x); });
  let left = max - quota.reduce((n, x) => n + x, 0);
  const order = share.map((x, p) => ({ p, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r || a.p - b.p);
  for (const { p } of order) {
    if (left <= 0) break;
    if (quota[p] < lists[p].length) { quota[p]++; left--; }
  }
  lists.forEach((l, p) => l.slice(0, quota[p]).forEach((i) => keep.add(i)));
  return items.filter((_, i) => keep.has(i));
}
