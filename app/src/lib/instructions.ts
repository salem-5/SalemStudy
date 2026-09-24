import type { QuestionType } from '../study/api';
import { pageId, type WalkSource } from './deckPlan.ts';

export type Brief = {
  text: string;
  pages: Set<string> | null;
  everyItem: boolean;
  count?: number;
  types?: QuestionType[];
  rules: string;
};

export const plainBrief = (text: string): Brief => ({ text, pages: null, everyItem: false, rules: '' });

const QUESTION_TYPES: QuestionType[] = ['mcq', 'multi', 'tf', 'numeric', 'short', 'blank'];

const OUTLINE_LINE = 140;

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

export const narrowWalk = (walk: WalkSource[], pages: Set<string> | null): WalkSource[] =>
  (pages ? walk.map((s) => ({ ...s, pages: s.pages.filter((p) => pages.has(pageId(p))) })).filter((s) => s.pages.length) : walk);

export const narrows = (walk: WalkSource[], pages: Set<string> | null): boolean =>
  !!pages && walk.some((s) => s.pages.some((p) => !pages.has(pageId(p))));

export function toBrief(text: string, walk: WalkSource[], raw: Record<string, unknown> | null): Brief {
  if (!raw) return plainBrief(text);
  const pages = raw.all_pages === true || !Array.isArray(raw.use)
    ? null
    : choosePages(walk, raw.use as { source?: unknown; pages?: unknown }[]);
  const count = Math.round(Number(raw.count));
  const types = Array.isArray(raw.types) ? QUESTION_TYPES.filter((t) => (raw.types as unknown[]).includes(t)) : [];
  return {
    text,
    pages: narrows(walk, pages) ? pages : null,
    everyItem: raw.every_item === true,
    ...(Number.isFinite(count) && count > 0 ? { count } : {}),
    ...(types.length ? { types } : {}),
    rules: String(raw.rules ?? '').trim(),
  };
}

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
