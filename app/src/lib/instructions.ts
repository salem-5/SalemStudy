/**
 * What the student asked for, read before a deck or quiz is written.
 *
 * The walk is built to cover every page, evenly, in reading order — the right
 * thing for "make me flashcards on these lectures", and exactly the wrong
 * thing for "only the true/false questions on the last page of each past
 * paper, with full proofs". Told that as a line of "focus" at the end of a
 * prompt that also says "every page gets at least one" and "keep explanations
 * to one or two sentences", a model does what the rest of the prompt says.
 *
 * So instructions are read first, once, against an outline of the material:
 * which pages they mean, whether they ask for particular items to be
 * collected (every question of a kind) or for a set written about the
 * material, how many, and of what kind. The walk then reads only those pages,
 * and every pass is told the instructions come before its own rules.
 *
 * Pure: no model, no Tauri. `studyGen` makes the one call.
 */

import type { QuestionType } from '../study/api';
import { pageId, type WalkSource } from './deckPlan.ts';

export type Brief = {
  /** The student's words, as they wrote them. */
  text: string;
  /** The pages to read, by `pageId`; null when the instructions mean all of it. */
  pages: Set<string> | null;
  /**
   * The student wants particular items collected from those pages — every
   * true/false question, every worked example — one card or question each,
   * however many that comes to, rather than a set sized by a setting.
   */
  everyItem: boolean;
  /** A number the student asked for. */
  count?: number;
  /** Question types the instructions call for (quizzes). */
  types?: QuestionType[];
  /** The instructions spelled out for the writer: what each item is and must contain. */
  rules: string;
};

/** Instructions read as nothing more than themselves: all pages, no selection. */
export const plainBrief = (text: string): Brief => ({ text, pages: null, everyItem: false, rules: '' });

const QUESTION_TYPES: QuestionType[] = ['mcq', 'multi', 'tf', 'numeric', 'short', 'blank'];

/** Longest a page's line in the outline gets: enough to tell what the page is. */
const OUTLINE_LINE = 140;

/**
 * Every source, every page, a line or two each — what the instructions are
 * read against. The last page is marked, since "the last page" is how a
 * student points at the end of an exam, and the page count is what makes
 * "the second half" mean something.
 */
export function outlineForInstructions(walk: WalkSource[]): string {
  return walk.map((s) => {
    const pages = [...s.pages].sort((a, b) => a.ord - b.ord);
    const lines = pages.map((p, i) => {
      const text = p.text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' / ');
      const tag = i === pages.length - 1 && pages.length > 1 ? ' (last page)' : '';
      return `${p.label}${tag}: ${text.slice(0, OUTLINE_LINE) || '(empty)'}`;
    });
    return [`=== ${s.title} — ${pages.length} ${pages.length === 1 ? 'page' : 'pages'} ===`, ...lines].join('\n');
  }).join('\n\n');
}

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const numberIn = (t: string) => /(\d+)/.exec(t)?.[1];

/**
 * The pages a reading of the instructions names, matched to real pages.
 *
 * `use` lists sources by title and, for each, the pages to read — page
 * labels as the outline shows them, a bare number, "last" or "first", or
 * "all" (or nothing) for the whole source. Titles are matched loosely; a
 * source or page that matches nothing is ignored. Null when nothing at all
 * matched, so a muddled reading falls back to the whole material rather than
 * to nothing.
 */
export function choosePages(walk: WalkSource[], use: { source?: unknown; pages?: unknown }[]): Set<string> | null {
  const chosen = new Set<string>();
  for (const entry of use) {
    const title = norm(String(entry.source ?? ''));
    if (!title) continue;
    const source = walk.find((s) => norm(s.title) === title)
      ?? walk.find((s) => norm(s.title).includes(title) || title.includes(norm(s.title)));
    if (!source) continue;
    const pages = [...source.pages].sort((a, b) => a.ord - b.ord);
    const asked = Array.isArray(entry.pages) ? entry.pages.map((p) => String(p).trim()).filter(Boolean) : [];
    if (!asked.length || asked.some((p) => /^all( pages)?$/i.test(p))) {
      for (const p of pages) chosen.add(pageId(p));
      continue;
    }
    for (const want of asked) {
      const w = want.toLowerCase();
      const page = /^last( page)?$/.test(w) ? pages[pages.length - 1]
        : /^first( page)?$/.test(w) ? pages[0]
          : pages.find((p) => p.label.toLowerCase() === w.replace(/\s*\(last page\)$/, ''))
            ?? (numberIn(w) ? pages.find((p) => numberIn(p.label) === numberIn(w)) : undefined);
      if (page) chosen.add(pageId(page));
    }
  }
  return chosen.size ? chosen : null;
}

/** The walk cut down to the chosen pages, sources with none left dropped. */
export const narrowWalk = (walk: WalkSource[], pages: Set<string> | null): WalkSource[] =>
  (pages ? walk.map((s) => ({ ...s, pages: s.pages.filter((p) => pages.has(pageId(p))) })).filter((s) => s.pages.length) : walk);

/** Whether a selection leaves out any page of the walk. */
export const narrows = (walk: WalkSource[], pages: Set<string> | null): boolean =>
  !!pages && walk.some((s) => s.pages.some((p) => !pages.has(pageId(p))));

/** The model's reading of the instructions, checked and made usable. */
export function toBrief(text: string, walk: WalkSource[], raw: Record<string, unknown> | null): Brief {
  if (!raw) return plainBrief(text);
  const pages = raw.all_pages === true || !Array.isArray(raw.use)
    ? null
    : choosePages(walk, raw.use as { source?: unknown; pages?: unknown }[]);
  const count = Math.round(Number(raw.count));
  const types = Array.isArray(raw.types) ? QUESTION_TYPES.filter((t) => (raw.types as unknown[]).includes(t)) : [];
  return {
    text,
    // Everything chosen is the same as no choice at all.
    pages: narrows(walk, pages) ? pages : null,
    everyItem: raw.every_item === true,
    ...(Number.isFinite(count) && count > 0 ? { count } : {}),
    ...(types.length ? { types } : {}),
    rules: String(raw.rules ?? '').trim(),
  };
}

/** A few words on what was chosen, for the progress line. */
export function describeChoice(walk: WalkSource[], brief: Brief): string {
  if (!brief.pages) return 'Following your instructions across all of the material';
  const narrowed = narrowWalk(walk, brief.pages);
  const n = narrowed.reduce((k, s) => k + s.pages.length, 0);
  const where = narrowed.slice(0, 4).map((s) => `${s.title} (${s.pages.map((p) => p.label.replace(/^[A-Za-z]+\s+/, '')).join(', ')})`).join('; ');
  return `Following your instructions: ${n} ${n === 1 ? 'page' : 'pages'} — ${where}${narrowed.length > 4 ? `; and ${narrowed.length - 4} more` : ''}`;
}

export const INSTRUCTIONS_SYSTEM = `You read a student's instructions for a flashcard deck or quiz that is about to be written from their course material, and turn them into a plan the writer follows exactly. You are shown the instructions and an outline of the material: every source with its title and page count, and for each page its label and first line or two.

- use / all_pages: which pages the instructions mean. When they point at particular sources or pages ("the past papers", "the last page of each exam", "lecture 3 only", "pages 4 to 9"), list each source to read by its exact title with the exact page labels, and set all_pages to false. "The last page" means the page marked (last page). A source the instructions exclude is simply not listed. Only when the instructions say nothing about where to look (they are about style, type or topic only) set all_pages to true.
- every_item: true when the student wants particular things collected or compiled from those pages — every true/false question, every exam question, every worked example, every theorem — one card or question for each, however many there are. False when they want a deck or quiz written about the material in the usual way.
- count: only when they ask for a number of cards or questions.
- types: for a quiz, the question types the instructions call for, by how the student would answer. short is a written answer: anything to explain, justify or prove — so true/false statements that come with proofs, "prove or disprove", or "justify your answer" are short, not tf. tf is only a bare true/false with nothing to write. Leave empty when the instructions do not bear on it.
- rules: the instructions restated as concrete rules for the writer — what each card or question is, what its answer and explanation must contain (a complete proof, a counterexample, every step), wording to keep, format. Keep every requirement the student gave; add none of your own. Leave out which pages to read; that is in use.`;

export const INSTRUCTIONS_SCHEMA = {
  type: 'object',
  properties: {
    all_pages: { type: 'boolean' },
    use: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'The exact title of the source.' },
          pages: { type: 'array', items: { type: 'string' }, description: 'Exact page labels from the outline, or ["all"] for the whole source.' },
        },
        required: ['source', 'pages'],
      },
    },
    every_item: { type: 'boolean' },
    count: { type: 'number' },
    types: { type: 'array', items: { type: 'string', enum: QUESTION_TYPES } },
    rules: { type: 'string' },
  },
  required: ['all_pages', 'every_item', 'rules'],
};
