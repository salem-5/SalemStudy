/**
 * How a deck or a quiz walks the material before a word of it is written.
 *
 * The student's use of a deck is to read a lecture, drill cards until they hit
 * one about something they have not read yet, then read on. That only works if
 * the cards follow the lecture page by page and leave nothing out — so the
 * material is walked, not sampled:
 *
 *   1. the sources are put in reading order (the numbers in their titles, or
 *      the order the student set);
 *   2. each source is cut into short runs of consecutive pages ("windows");
 *   3. every window gets its own pass, writing only for its own pages but able
 *      to see the whole of the material around it.
 *
 * The number of cards is not chosen up front. Each pass writes as many as its
 * pages need — none for a title slide, several for a dense one — and the total
 * is whatever the material came to, up to the setting's ceiling (`CEILING`).
 * Past the ceiling the deck is thinned page by page, so on a very large set of
 * sources the last lecture is not the one that gets left out.
 *
 * Pure: no model, no Tauri. `studyGen` does the calling.
 */

import type { Difficulty, SourceHit, SourceKind } from '../study/api';

/**
 * How thorough to be. A number of cards means nothing to a student choosing it
 * — "30" could be everything or a tenth of it — so they say this instead.
 */
export type CardSize = 'fewer' | 'standard' | 'more';

export type CardOptions = {
  size?: CardSize;
  difficulty?: Difficulty | 'mixed';
};

/** The material a deck or quiz is built from. */
export type GenSource =
  | { kind: 'topic'; prompt: string }
  | { kind: 'chat'; messages: { role: string; content: string }[] }
  | { kind: 'mistakes'; items: { prompt: string; answer: string; explanation: string; topic: string }[] }
  | { kind: 'sources'; hits: SourceHit[]; notes?: { id: number; title: string; content: string }[]; focus: string };

/** Past this a deck stops being something anyone sits down and reviews. */
export const MAX_ITEMS = 96;

// ------------------------------------------------------------ reading order

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
  // "LIVE", "MIX" and friends are words, not numerals; a real one round-trips.
  return total > 0 && total < 60 ? total : null;
}

const KEYWORD = String.raw`(?:lecture|lect|lec|l|week|wk|w|chapter|chap|ch|part|pt|session|sess|unit|module|mod|topic|section|sec|day|class|lesson|les|tutorial|tut|lab|practical|seminar|block|set|no\.?|#)`;
const NUMBER = String.raw`(\d{1,3}|[ivxl]{1,6}|[a-z]+)`;

/**
 * The position a title claims for itself, if it claims one.
 *
 * "Lecture 5, Equations of Planes" → 5, "MSK L1,L2" → 1, "Part II" → 2,
 * "03 - Intro" → 3, "Week three" → 3. A number that is only part of the
 * subject ("the 3 Dimensional Space", "2024 notes") is not a position, so only
 * a number that follows a word like "lecture" or opens the title counts.
 */
export function ordinalOf(title: string): number | null {
  const t = title.trim();
  // Every candidate, left to right: "Lab safety, Lecture 3" has to get past
  // "Lab safety" to find the 3.
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

/**
 * The order the material should be read in.
 *
 * Titles that carry a position go in that order; the rest follow in the order
 * they were added, which is the order the student thought of them in. Upload
 * order alone is not enough: a course's lectures are as often added newest
 * first as oldest.
 */
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

/**
 * The student's own order, where they set one, with anything new placed by
 * the default rule after it. Ids that no longer exist are simply dropped.
 */
export function applyOrder<T extends { id: number; title: string; createdAt: number }>(sources: T[], saved: number[] | undefined): T[] {
  const natural = readingOrder(sources);
  if (!saved?.length) return natural;
  const byId = new Map(sources.map((s) => [s.id, s]));
  const kept = saved.map((id) => byId.get(id)).filter((s): s is T => !!s);
  const seen = new Set(kept.map((s) => s.id));
  return [...kept, ...natural.filter((s) => !seen.has(s.id))];
}

// ----------------------------------------------------------------- windows

export type Page = {
  sourceId: number;
  sourceTitle: string;
  kind: SourceKind;
  /** 0-based position in the source. */
  ord: number;
  /** "Page 12", "Slide 4". */
  label: string;
  text: string;
};

export type WalkSource = {
  id: number;
  title: string;
  kind: SourceKind;
  pages: Page[];
};

/** A run of consecutive pages of one source, written up in one pass. */
export type Window = {
  index: number;
  sourceId: number;
  sourceTitle: string;
  pages: Page[];
  /** The label of its first and last page. */
  from: string;
  to: string;
  chars: number;
};

/**
 * How much of a lecture one pass writes up.
 *
 * Small enough that nothing on the pages is glossed over; large enough that a
 * point spanning two slides lands in one pass. The pass can see everything
 * around it anyway, so the boundary costs nothing but a card or two that
 * would have been one.
 */
export const WINDOW_CHARS = 6_000;

/**
 * Fast mode's passes: twice the pages each, so half as many calls, each of
 * which carries the instructions and the outline once.
 */
export const FAST_WINDOW_CHARS = 12_000;

/** A page with nothing on it but a heading still belongs somewhere. */
const pageChars = (p: Page) => Math.max(40, p.text.trim().length);

/**
 * Roughly how much text a complete pass writes one card for.
 *
 * Measured on the student's own reference deck where it was complete: 17
 * cards for pages 3–6 of a pathology lecture, about one per 275 characters of
 * extracted slide text. (Over the whole deck it looks sparser, but that deck
 * thins out and stops two thirds of the way through — which is the problem
 * the walk exists to fix, not a density to copy.)
 */
const CHARS_PER_ITEM = 275;

/** What is being written: a deck's cards or a quiz's questions. */
export type SetOf = 'cards' | 'questions';

/**
 * How many cards each setting may come to: a band from the setting below's
 * ceiling up to its own. Where a deck lands in its band follows the length of
 * the material — a full lecture near the top, a short one near the bottom —
 * so the count is not the same number every time.
 */
export const CARD_BANDS: Record<CardSize, [number, number]> = { fewer: [8, 32], standard: [32, 64], more: [64, 96] };

/** A quiz is exactly this long: a quiz is sat, and its length is a promise. */
export const QUIZ_COUNT: Record<CardSize, number> = { fewer: 8, standard: 16, more: 28 };

/** The most each setting ever comes to, for decks. */
export const CEILING: Record<CardSize, number> = { fewer: CARD_BANDS.fewer[1], standard: CARD_BANDS.standard[1], more: CARD_BANDS.more[1] };

/** The ceiling for either: a deck's band top, or a quiz's exact length. */
export const ceilingOf = (size: CardSize, of: SetOf): number => (of === 'questions' ? QUIZ_COUNT[size] : CEILING[size]);

/** How each setting scales what a complete pass would write. */
const FACTOR: Record<CardSize, number> = { fewer: 0.55, standard: 1, more: 1.5 };

/**
 * How long a lecture is "full" for placing a deck in its band: about 150
 * cards' worth of text (roughly 40,000 characters, a long lecture).
 */
const FULL = 150;

/**
 * How many items a deck or quiz of this material comes to, at each setting.
 *
 * A quiz is its setting's exact length. A deck lands in its band by how long
 * the material is, and never past what the material could fill at that
 * setting — a two-page handout is not padded out to thirty-two cards. The
 * three are always in order: Fewer below Standard below More. A number the
 * student asked for replaces the setting's own, within `MAX_ITEMS`.
 */
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

/**
 * Whether the setting's ceiling holds the deck below what a complete pass
 * would write — a long lecture on Standard, a whole course on anything, and
 * nearly every quiz. Then each pass is told to spend its share on what
 * matters most rather than to write up every fact.
 */
export const isShrunk = (windows: Pick<Window, 'chars'>[], size: CardSize, limit?: number, fast = false, of: SetOf = 'cards'): boolean => {
  const natural = windows.reduce((n, w) => n + w.chars, 0) / CHARS_PER_ITEM;
  const as = writtenAs(size, fast);
  return budgetFor(windows, as, limit, of) < Math.round(natural * FACTOR[as]) - 1;
};

/**
 * Fewer is written as Standard is and cut down to its core afterwards:
 * asked for "only the essentials" alongside a dozen lines about leaving
 * nothing out, a model writes everything anyway. So its passes are told
 * Standard's scale, and the choosing is done by `balancedTrim`.
 */
export const writtenAs = (size: CardSize, fast = false): CardSize => (size === 'fewer' && !fast ? 'standard' : size);
// (In fast mode Fewer is told its own number instead: writing a whole
// Standard deck to keep a third of it is most of what a Fewer deck cost.)

/**
 * About how many items this pass comes to: its share, by length, of the
 * deck the setting makes of the whole material.
 *
 * Told to the model as a sense of scale, never as a quota. Left to itself a
 * model has none: shown a ceiling it writes up to it, shown nothing it splits
 * a single diagram into two dozen cards. Because it is a share of the pages'
 * length it still comes from the material — a pass over three title slides is
 * told a small number, a pass over a dense page of lists a larger one.
 */
export const expectedItems = (w: Pick<Window, 'chars'>, all: Pick<Window, 'chars'>[], size: CardSize, limit?: number, fast = false, of: SetOf = 'cards'): number => {
  const total = all.reduce((n, x) => n + x.chars, 0) || 1;
  return Math.max(1, Math.round((w.chars / total) * budgetFor(all, writtenAs(size, fast), limit, of)));
};

/**
 * Cut the sources into windows, in reading order.
 *
 * A window never splits a page and never crosses from one source into the
 * next.
 */
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

/** The key an item's page is known by: source and position. */
export const pageId = (p: Pick<Page, 'sourceId' | 'ord'>) => `${p.sourceId}:${p.ord}`;

/** What is on a page once the extractor's own placeholders are gone. */
const substance = (p: Page) => p.text.replace(/^\s*scanned page\s*$/gim, '').replace(/\s+/g, ' ').trim();

/**
 * The pages of a window its pass left without a single item, as a window of
 * their own — or null when every page with something on it was covered.
 *
 * A pass sometimes stops early: asked for a dozen cards over nine pages, it
 * wrote seven and stopped at the fourth page. The walk promises every page,
 * so what it skipped gets a second, smaller pass. A page with next to nothing
 * on it (a divider, the title slide) is not chased.
 */
export function uncovered(window: Window, covered: Set<string>, minChars = 60): Window | null {
  // A short first page is the title slide — the course and who teaches it.
  // Chased, it comes back as cards on the lecturer's affiliation.
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

/** "Page 3" or "Pages 3–9". */
export const pagesLabel = (w: Pick<Window, 'from' | 'to'>) => (w.from === w.to ? w.from : `${w.from}–${w.to.replace(/^[A-Za-z]+\s+/, '')}`);

// ------------------------------------------------------------ the material

/** One source, page by page, as the model reads it. */
export const renderSource = (source: WalkSource): string =>
  [
    `=== ${source.title} ===`,
    ...source.pages
      .filter((p) => p.text.trim())
      .map((p) => `--- ${p.label} ---\n${p.text.trim()}`),
  ].join('\n\n');

/** The first line of each page: enough to know where a source goes. */
export const outlineSource = (source: WalkSource): string =>
  [
    `=== ${source.title} (outline) ===`,
    ...source.pages
      .filter((p) => p.text.trim())
      .map((p) => `${p.label}: ${p.text.trim().split('\n').find((l) => l.trim())?.trim().slice(0, 100) ?? ''}`),
  ].join('\n');

/**
 * Past this the whole of the material stops going into every pass; each pass
 * gets its own source in full and an outline of the rest.
 */
export const FULL_CONTEXT_CHARS = 180_000;

/**
 * What every pass over `sourceId` is shown besides its own pages.
 *
 * All of it, when it fits: that is what lets a card on page 30 lean on a
 * definition from page 3, and it is identical for every pass, so the provider
 * caches it after the first. Otherwise the source being walked in full, and
 * the others in outline.
 */
export function materialFor(sources: WalkSource[], sourceId: number): string {
  const total = sources.reduce((n, s) => n + s.pages.reduce((m, p) => m + p.text.length, 0), 0);
  if (total <= FULL_CONTEXT_CHARS) return sources.map(renderSource).join('\n\n');
  return sources.map((s) => (s.id === sourceId ? renderSource(s) : outlineSource(s))).join('\n\n');
}

/**
 * What a pass is shown in fast mode: an outline of everything (so it still
 * knows what comes before and after), then its own pages in full.
 *
 * Every pass reading the whole of a long lecture is most of what a deck
 * costs: seven passes over forty pages is seven times forty pages of input.
 * The outline keeps the part of that which matters — where each page sits
 * and what it is about — at a fraction of the size. The outline comes first
 * and is the same for every pass, so the provider can still cache it.
 */
export function fastMaterialFor(sources: WalkSource[], window: Pick<Window, 'sourceId' | 'sourceTitle' | 'pages'>): string {
  const outline = sources.map(outlineSource).join('\n\n');
  const own = renderSource({ id: window.sourceId, title: window.sourceTitle, kind: window.pages[0]?.kind ?? 'pdf', pages: window.pages });
  return `${outline}\n\n# In full: the pages of this pass\n\n${own}`;
}

/** How thorough one pass should be, in the model's terms. */
export function sizeRule(size: CardSize, what: 'cards' | 'questions', shrunk = false): string {
  const one = what === 'cards' ? 'card' : 'question';
  const tag = `Mark every ${one}'s importance. core: a student who knew only the core ${one}s would still pass the exam on these pages — the definitions of the key terms, the main stages and classifications, the numbers that get examined, the classic features, causes and complications. detail: everything else worth knowing — the supporting facts, the second and third examples, the finer points. Be strict: on a typical page about a third to a half is core.`;
  if (size === 'more') {
    return `Everything a complete pass would write — a separate ${one} for every fact worth knowing on these pages — and then more for the same pages: ones that compare two things students confuse, connect a cause to its consequence, ask the student to apply a fact rather than repeat it, and cover the smaller details a complete pass might pass over. Keep them in the order of the pages.\n\n${tag}`;
  }
  // Fewer is written exactly like standard and filtered to its core
  // afterwards (see `writtenAs`).
  if (shrunk) {
    return `Cover every page, and on each page every point a student is examined on — each key definition, stage, classification, number, cause, feature, complication — one ${one} per point. Fold the minor supporting facts into the ${one} they support instead of giving each its own. Do not summarise a page away and do not pad.\n\n${tag}`;
  }
  return `Every fact on these pages that is worth knowing — each definition, stage, number, cause, feature, investigation, complication — gets its own ${one}. A dense slide is several; a title or divider page is none. Do not summarise and do not skip anything; do not pad either.\n\n${tag}`;
}

/**
 * What Fewer keeps before it is trimmed: the core items, and for a page the
 * model marked nothing core on, its first item — a short slide that only
 * names four conditions is still a page the student has to have read.
 */
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

/**
 * Bring a walk over the ceiling back under it without losing any page.
 *
 * Cutting the list at the ceiling drops the last pages entirely — exactly the
 * failure a walk exists to prevent. So it is done page by page: first every
 * page keeps one item (its first core one), and what room is left goes to the
 * pages in proportion to how much each wrote, so a dense page keeps more than
 * a sparse one instead of every page being flattened to the same two. Within
 * a page core items go before details, in the order they were written (the
 * model writes the main point first). When there is not even one item per
 * page to go round, the pages that keep one are spread across the material.
 */
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
    // Not enough for every page: spread what there is.
    for (let k = 0; k < max; k++) keep.add(lists[Math.floor((k * lists.length) / max)][0]);
    return items.filter((_, i) => keep.has(i));
  }
  const quota = lists.map(() => 1);
  // The rest by largest remainder over what each page has left to give.
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
