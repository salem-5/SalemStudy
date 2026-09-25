import { pythonStatus, runPython } from './python';
import { cardGuidance, courseFlavour, guidance, pageByPageFor, WALK_SCHEMA, WALK_SYSTEM } from './subjects';
import {
  balancedTrim, budgetFor, fitHits, CEILING, QUIZ_COUNT, expectedItems, FAST_WINDOW_CHARS, fastMaterialFor, WINDOW_CHARS, coreOnly, isShrunk, MAX_ITEMS, pageId, uncovered, materialFor, pagesLabel, planWalk, sizeRule,
  type CardOptions, type CardSize, type GenSource, type Page, type WalkSource, type Window,
} from './deckPlan';
import { generate, generateQuick } from './salem/generate';
import { diagramQuestions, type FoundDiagram } from './diagrams';
import type { Meter } from './meter';
import { isStop, type Stop } from './cancel.ts';
import { TITLE_RULE, tidyTitle } from './titles';
import { CARDS_DIRECT_SYSTEM, CARDS_SYSTEM, GAP_GRADE_SYSTEM, GRADE_SYSTEM, LABELS_GRADE_SYSTEM, QUIZ_DIRECT_SYSTEM, QUIZ_SYSTEM } from './prompts';
import { canCheck, checkAgrees, defaultTolerance, fillsTheGap, labelAnswers, labelResults, parseNumber, shuffleChoices, usableHint } from './quizRules';
import { describeChoice, INSTRUCTIONS_SCHEMA, INSTRUCTIONS_SYSTEM, narrowWalk, outlineForInstructions, plainBrief, toBrief, type Brief } from './instructions';
import { studyApi, type NewCard, type Difficulty, type QuestionType, type QuizQuestion, type SourceHit } from '../study/api';

export type StudyContext = { subject: string; notebook: string; courseContext: string };

export type QuizOptions = {
  difficulty?: Difficulty | 'mixed';
  types?: QuestionType[];
  size?: CardSize;
  limit?: number;
  diagrams?: boolean;
  /** The diagrams the student ticked. Left out, the AI chooses them from the sources. */
  diagramPicks?: FoundDiagram[];
} & RunOptions;

export type WalkChoice = boolean | 'auto';

export type RunOptions = {
  fast?: boolean;
  walk?: WalkChoice;
  meter?: Meter;
  stop?: Stop;
};

function cardStyle(ctx: StudyContext, options: CardOptions): string {
  const lines = [cardGuidance(courseFlavour(ctx))];
  if (options.difficulty && options.difficulty !== 'mixed') lines.push(`Pitch them at a ${options.difficulty} level.`);
  return lines.join('\n');
}

const TYPE_LABEL: Record<QuestionType, string> = {
  mcq: 'single-answer multiple choice',
  multi: 'select-all-that-apply',
  tf: 'true/false',
  numeric: 'numeric answer',
  short: 'short written answer',
  blank: 'fill in the blank',
  label: 'label-the-diagram',
};

const TYPE_FIT = 'Anything the student has to explain, justify or prove is a short written answer - including a true/false statement that has to be proved or disproved: the prompt gives the statement and asks "True or false? Prove it, or give a counterexample.", and the model answer is the verdict followed by the complete proof or counterexample. tf is only for a bare claim with nothing to write; numeric for a single computed number; blank for one key term or value; mcq and multi for choosing between options.';

function describeOptions(options: QuizOptions, brief: Brief | null = null): string {
  const lines: string[] = [];
  if (brief?.types?.length) {
    options = { ...options, types: brief.types };
  }
  if (options.difficulty && options.difficulty !== 'mixed') {
    lines.push(`Difficulty: ${options.difficulty}. Every question should be at about this level.`);
  } else {
    lines.push('Difficulty: mixed - a few easy, most medium, one or two hard. Set each question\'s difficulty honestly.');
  }
  options = { ...options, types: options.types?.filter((t) => t !== 'label') };
  const narrowed = !!options.types?.length && options.types.length < TYPES.length;
  if (narrowed && options.types!.length === 1) {
    lines.push(`Every question is ${TYPE_LABEL[options.types![0]]}.`);
  } else {
    lines.push(narrowed
      ? `Question types allowed: ${options.types!.map((t) => TYPE_LABEL[t]).join(', ')}.`
      : 'Any question type may be used.');
    lines.push(`${brief ? "Where the student's instructions name a type, use it. Otherwise, f" : 'F'}or each question pick the one type${narrowed ? ' of these' : ''} that fits how it would really be answered - never a type chosen for variety. ${TYPE_FIT}`);
  }
  return lines.join('\n');
}

function describeSource(src: GenSource): string {
  if (src.kind === 'topic') return `Material to cover (from the student):\n${src.prompt}`;
  if (src.kind === 'sources') {
    const blocks = src.hits.map((h) => `<excerpt source="${h.sourceTitle}" where="${h.label}">\n${h.text}\n</excerpt>`).join('\n\n');
    const notes = (src.notes ?? [])
      .map((n) => `<note title="${n.title}">\n${n.content.slice(0, 30_000)}\n</note>`)
      .join('\n\n');
    const material = [blocks, notes].filter(Boolean).join('\n\n');
    const what = src.notes?.length && src.hits.length ? "course material and the student's own notes"
      : src.notes?.length ? "the student's own notes" : "the student's course material";
    return `Base everything on this ${what} (not on outside knowledge). ${src.focus.trim() ? `The student's instructions come first - follow them exactly, even where they differ from the usual way:\n${src.focus.trim()}` : 'Cover the important ideas across all of it.'}\n\n${material}`;
  }
  if (src.kind === 'mistakes') {
    return `Questions the student got wrong:\n${src.items.map((m, i) => `${i + 1}. ${m.prompt}\n   Answer: ${m.answer}\n   Why: ${m.explanation}`).join('\n')}`;
  }
  const transcript = src.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role === 'user' ? 'Student' : 'Tutor'}: ${m.content}`)
    .join('\n\n');
  return `Base everything on this conversation (the tutor's explanations are the reference):\n\n${transcript.slice(-60_000)}`;
}

function contextBlock(ctx: StudyContext): string {
  return `Course: ${ctx.subject}\nNotebook: ${ctx.notebook}${ctx.courseContext.trim() ? `\nCourse notes (notation, conventions - follow them):\n${ctx.courseContext.trim()}` : ''}

## This subject
${guidance(courseFlavour(ctx))}`;
}

type GenTool = { function: { name: string; parameters: unknown } };

async function generated(system: string, user: string, tool: GenTool, meter?: Meter, stop?: Stop): Promise<Record<string, unknown>> {
  const feature = tool.function.name === 'save_flashcards' ? 'flashcards' : 'quiz';
  return generate<Record<string, unknown>>({
    feature,
    system,
    instruction: user,
    schema: tool.function.parameters,
    meter,
    stop,
  });
}

const CARDS_TOOL = {
  type: 'function',
  function: {
    name: 'save_flashcards',
    description: 'Save the flashcards.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: `A name for the whole deck - all of the material, not only the pages you are writing: ${TITLE_RULE}` },
        cards: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              front: { type: 'string', description: 'A cue asking for exactly ONE thing. Markdown; maths in $...$.' },
              back: { type: 'string', description: "The answer to that one thing, short, with at most one line of why - unless the student's instructions ask for more (a full proof, a worked solution), in which case all of it. If the back would list two things, split it into two cards. Markdown; maths in $...$." },
              topic: { type: 'string', description: 'Short topic name, e.g. "Ratio test".' },
              importance: { type: 'string', enum: ['core', 'detail'], description: 'core: needed to pass the exam on this material. detail: worth knowing, but supporting.' },
              from_source: { type: 'string', description: 'The exact title of the excerpt or note this card came from, so the student can trace it back. Leave it out only if you wrote it from general knowledge.' },
              from_where: { type: 'string', description: 'Where in that source, exactly as the excerpt is labelled (e.g. "page 12", "slide 4").' },
            },
            required: ['front', 'back'],
          },
        },
      },
      required: ['title', 'cards'],
    },
  },
};

export function hitsToWalk(hits: SourceHit[]): WalkSource[] {
  const out: WalkSource[] = [];
  for (const hit of hits) {
    let source = out[out.length - 1];
    if (!source || source.id !== hit.sourceId) {
      source = out.find((s) => s.id === hit.sourceId) ?? { id: hit.sourceId, title: hit.sourceTitle, kind: hit.kind, pages: [] };
      if (!out.includes(source)) out.push(source);
    }
    source.pages.push({
      sourceId: hit.sourceId,
      sourceTitle: hit.sourceTitle,
      kind: hit.kind,
      ord: hit.unitFrom,
      label: hit.label,
      text: hit.text,
    });
  }
  return out;
}

function pageRef(raw: RawQuestion, window: Window): QuizQuestion['sources'] | null {
  const where = String(raw.from_where ?? '').trim().toLowerCase();
  const number = /(\d+)/.exec(where)?.[1];
  const named = window.pages.find((p) => p.label.toLowerCase() === where)
    ?? (number ? window.pages.find((p) => /(\d+)/.exec(p.label)?.[1] === number) : undefined);
  if (!named && number) return null;
  const page: Page = named ?? window.pages[0];
  return [{ sourceId: page.sourceId, title: page.sourceTitle, label: page.label, unit: page.ord }];
}

async function inOrder<T, R>(items: T[], limit: number, work: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed: unknown = null;
  const lane = async () => {
    while (next < items.length && failed === null) {
      const i = next++;
      try { out[i] = await work(items[i], i); } catch (e) { failed ??= e; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  if (failed !== null) throw failed;
  return out;
}

const unlessStopped = (e: unknown): null => {
  if (isStop(e)) throw e;
  return null;
};

const PARALLEL_PASSES = 3;

export const DIRECT_CARD_COUNT: Record<CardSize, number> = { fewer: 15, standard: 30, more: 50 };

const WALK_CACHE = 'wa.walk.auto.';

const walkKey = (ctx: StudyContext) => `${WALK_CACHE}${ctx.subject.trim().toLowerCase()}|${ctx.notebook.trim().toLowerCase()}`;

async function resolveWalk(
  ctx: StudyContext,
  src: GenSource,
  choice: WalkChoice | undefined,
  what: 'cards' | 'questions',
  progress: (text: string) => void,
  meter?: Meter,
  stop?: Stop,
): Promise<boolean> {
  if (src.kind !== 'sources' || !src.hits.length) return false;
  if (choice === true || choice === false) return choice;
  try {
    const kept = JSON.parse(localStorage.getItem(walkKey(ctx)) || 'null') as { walk?: unknown } | null;
    if (typeof kept?.walk === 'boolean') return kept.walk;
  } catch { }
  progress('Choosing how to go through this subject…');
  const titles = [...new Set(src.hits.map((h) => h.sourceTitle))].slice(0, 30);
  const raw = await generateQuick<{ page_by_page?: unknown; reason?: unknown }>({
    feature: what === 'cards' ? 'flashcards' : 'quiz',
    system: WALK_SYSTEM,
    instruction: `Course: ${ctx.subject}\nNotebook: ${ctx.notebook}${ctx.courseContext.trim() ? `\nCourse notes: ${ctx.courseContext.trim().slice(0, 1500)}` : ''}\nSources:\n${titles.map((t) => `- ${t}`).join('\n')}`,
    schema: WALK_SCHEMA,
    meter,
    stop,
  }).catch(unlessStopped);
  const walk = typeof raw?.page_by_page === 'boolean' ? raw.page_by_page : pageByPageFor(courseFlavour(ctx));
  const reason = String(raw?.reason ?? '').trim();
  if (raw) {
    try { localStorage.setItem(walkKey(ctx), JSON.stringify({ walk, reason })); } catch { }
  }
  progress(`Page by page ${walk ? 'on' : 'off'} for ${ctx.subject}${reason ? `: ${reason}` : ''}`);
  return walk;
}

const instructionsOf = (src: GenSource) => (src.kind === 'sources' ? src.focus.trim() : '');

const directSource = (src: GenSource): GenSource => (src.kind === 'sources' ? { ...src, hits: fitHits(src.hits) } : src);

function withInstructions(system: string, text: string, what: 'cards' | 'questions'): string {
  if (!text.trim()) return system;
  const one = what === 'cards' ? 'card' : 'question';
  return `# The student's instructions come first
The student gave these instructions for this ${what === 'cards' ? 'deck' : 'quiz'}. Follow them exactly: which parts of the material to use, how many ${what}, what kind, and what each ${one} and its answer must contain. They override every default below; where a default disagrees with them, the instructions win.
"""
${text.trim()}
"""

${system}`;
}

const reminderOf = (text: string, what: 'cards' | 'questions') => (text
  ? `\n\nBefore you answer, check every ${what === 'cards' ? 'card' : 'question'} against the student's instructions: anything they did not ask for goes, and anything they asked for is there.`
  : '');

function allowedTypes(options: QuizOptions, brief: Brief | null): QuestionType[] | null {
  if (brief?.types?.length) return brief.types.filter((t) => t !== 'label');
  const types = options.types?.filter((t) => t !== 'label');
  if (types?.length && types.length < TYPES.length) return types;
  return null;
}

function walkPlan(walk: WalkSource[], fast: boolean) {
  const windows = planWalk(walk, fast ? FAST_WINDOW_CHARS : WINDOW_CHARS);
  return {
    windows,
    fast,
    parallel: fast ? 6 : PARALLEL_PASSES,
    material: (w: Window) => (fast ? fastMaterialFor(walk, w) : materialFor(walk, w.sourceId)),
  };
}

const MISSED_NOTE = '\n\nThe first pass over this part of the material stopped before reaching these pages. Write for them now - the same way, at the same depth - and only for them: nothing from any other page. A title page (the course, the lecturers), a divider, or a page that only repeats an earlier one gets nothing; returning an empty list is fine.';

const chaseGaps = (brief: Brief | null) => !brief || !!brief.pages;

function inPageOrder<T extends { item: { sourceRefs?: unknown; sources?: QuizQuestion['sources'] } }>(items: T[]): T[] {
  const unit = (t: T) => ((t.item.sources ?? (t.item.sourceRefs as QuizQuestion['sources']))?.[0]?.unit ?? 0);
  return items.map((t, i) => ({ t, i })).sort((a, b) => unit(a.t) - unit(b.t) || a.i - b.i).map((x) => x.t);
}

const errorText = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 200);

function passPrompt(
  ctx: StudyContext,
  material: string,
  window: Window,
  what: 'cards' | 'questions',
  size: CardSize,
  extra: string,
  brief: Brief | null,
  all: Window[],
  limit?: number,
  fast = false,
): string {
  const shrunk = isShrunk(all, size, limit, fast, what);
  const rule = sizeRule(size === 'fewer' && fast ? 'standard' : size, what, shrunk || (fast && size === 'fewer'));
  const share = expectedItems(window, all, size, limit, fast, what);
  const scale = what === 'questions' ? Math.max(1, Math.ceil(share * 1.25)) : share;
  const most = Math.max(scale + 1, Math.ceil(scale * 1.15));
  const noun = what === 'cards' ? 'flashcards' : 'quiz questions';
  const one = what === 'cards' ? 'card' : 'question';
  const order = window.pages.map((p) => p.label).join(', ');
  const collect = !!brief?.everyItem && !limit;
  const sized = !collect && !limit;
  return [
    contextBlock(ctx),
    '# The material',
    brief?.pages
      ? "The pages the student's instructions point at, in the order they are read."
      : fast
        ? 'An outline of all of it, in the order it is read - the first line of every page - and then, in full, the pages you are writing for. The outline is there so you know what comes before and after.'
        : 'All of it, in the order it is read. You are writing for only part of it (below); the rest is here so you know what comes before and after.',
    material,
    '# Your pass',
    `Write the ${noun} for “${window.sourceTitle}”, ${pagesLabel(window)} - those pages and nothing else. Other passes cover every other page, so anything outside these pages will be written by them; do not write it here, even if it is important.`,
    `Go through these pages from the top of the first to the bottom of the last, in order: ${order}. Write the ${what} for each part as you reach it, so they come out in the order the material teaches it.`,
    'Use the rest of the material for context: a question can lean on a definition from an earlier page, and should not ask about something as if it were new when these pages are only mentioning it in passing.',
    collect
      ? `The student asked for particular items from these pages (see their instructions below). Write one ${one} for every such item on these pages - all of them, in the order they appear, however many there are - and nothing else: no ${one}s on anything the instructions did not ask for. Mark every one core. If these pages hold none, return an empty list.`
      : brief ? `${rule}\n\nWhat is worth a ${one} here is decided by the student's instructions below.` : rule,
    brief ? '' : 'A page of yours that only repeats something an earlier page already said - a recap slide, a diagram of a process the text before it described - gets cards only for what is new on it; the pass that wrote the earlier page has the rest.',
    `Record the page each one came from in from_where, exactly as the page is labelled (e.g. “${window.pages[0].label}”). That is the only place a page goes: the ${one} itself never mentions a page, slide or “the diagram” - the student answers it without the material in front of them, so ask about the thing itself.`,
    collect ? ''
      : brief && limit
        ? `The student asked for ${limit} in all; these pages' share is about ${scale}, and no more than ${most}.${brief.pages ? '' : ' Spend them on what the instructions ask for.'}`
        : brief && sized
          ? `For pages like these, this setting usually comes to about ${scale}, but the student's instructions decide what goes in: a page they do not bear on gets nothing.`
          : fast
            ? `Write about ${scale} for these pages, and no more than ${most}. ${size === 'fewer' ? 'Only what a student has to know to pass: the key definitions, stages, numbers, classic features and complications.' : 'Spend them on what matters most.'} Spread them across all of these pages from the first to the last - do not use them up before you reach the end. Every page that teaches something gets at least one, however short it is; a title or divider page gets none. Leave from_source out: from_where is enough.`
            : shrunk
            ? `The whole ${what === 'cards' ? 'deck' : 'quiz'} is kept to a size a student can work through, so these pages come to about ${scale}. Spend them on what matters most, spread across all of these pages from the first to the last - do not use them up before you reach the end. Every page that teaches something gets at least one, however short it is: a slide that only names four conditions still gets a card asking for them. A title or divider page gets none.`
            : `For pages like these, this setting usually comes to about ${scale}. That is a sense of scale, not a quota: write fewer if the pages hold less than their length suggests (long figure descriptions, a recap of an earlier page), more if they are dense with separate facts. A title or divider page gets none.`,
    brief ? '' : 'No single page needs more than about eight. If one seems to - a diagram with many labels, a long table - you are splitting one idea into many: ask for the list as a list, or keep to the labels that are worth learning.',
    fast && what === 'questions'
      ? brief
        ? "Keep every hint to one short line. Explanations are as long as the student's instructions need - a complete proof or worked solution when they ask for one; otherwise one or two sentences. Write check_code for every question whose answer can be computed or tested, including true/false and prove-or-disprove claims."
        : 'Keep every explanation to one or two sentences and every hint to one short line. Write check_code for every question whose answer can be computed or tested, including true/false and prove-or-disprove claims.'
      : '',
    extra,
    brief ? instructionsBlock(brief, what) : '',
  ].filter(Boolean).join('\n\n');
}

function instructionsBlock(brief: Brief, what: 'cards' | 'questions'): string {
  const one = what === 'cards' ? 'card' : 'question';
  return [
    "# The student's instructions",
    `These come first. Follow them exactly - what each ${one} is, what kind it is, what it must contain and how it is set out - even where they differ from the usual way of writing ${what} described above. Where they ask for more than the defaults allow (a full proof in the ${what === 'cards' ? 'back' : 'explanation'}, every step of a solution), give it.`,
    `In their words:\n"""\n${brief.text.trim()}\n"""`,
    brief.rules ? `What that means for each ${one}:\n${brief.rules}` : '',
  ].filter(Boolean).join('\n\n');
}

async function readInstructions(what: 'cards' | 'questions', text: string, walk: WalkSource[], meter?: Meter, stop?: Stop): Promise<Brief> {
  const raw = await generateQuick<Record<string, unknown>>({
    feature: what === 'cards' ? 'flashcards' : 'quiz',
    system: INSTRUCTIONS_SYSTEM,
    instruction: `This is for a ${what === 'cards' ? 'flashcard deck' : 'quiz'}.\n\n# The student's instructions\n${text.trim()}\n\n# The material\n${outlineForInstructions(walk)}`,
    schema: INSTRUCTIONS_SCHEMA,
    meter,
    stop,
  }).catch(unlessStopped);
  return raw ? toBrief(text, walk, raw) : plainBrief(text);
}

async function prepareWalk(what: 'cards' | 'questions', src: GenSource, progress: (text: string) => void, meter?: Meter, stop?: Stop) {
  const full = src.kind === 'sources' ? hitsToWalk(src.hits) : [];
  const text = src.kind === 'sources' ? src.focus.trim() : '';
  if (!full.length || !text) return { walk: full, brief: null };
  progress('Reading your instructions…');
  const brief = await readInstructions(what, text, full, meter, stop);
  progress(describeChoice(full, brief));
  return { walk: narrowWalk(full, brief.pages), brief };
}

async function nameIt(what: 'deck' | 'quiz', sources: WalkSource[], topics: string[], fallback: string, meter?: Meter): Promise<string> {
  const covered = [...new Set(topics.map((t) => t.trim()).filter(Boolean))].slice(0, 40);
  if (!covered.length) return fallback;
  const args = await generateQuick<{ title?: unknown }>({
    feature: what === 'deck' ? 'flashcards' : 'quiz',
    system: `Name a study ${what} by what it covers: ${TITLE_RULE} It covers everything listed, so name all of it, not the first part.`,
    instruction: `What it covers, in order:\n${covered.map((t) => `- ${t}`).join('\n')}`,
    schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
    meter,
  }).catch(unlessStopped);
  const title = tidyTitle(String(args?.title ?? ''), sources.map((x) => x.title));
  return title ? title.slice(0, 80) : fallback;
}

const pageKey = (item: { sourceRefs?: unknown; sources?: QuizQuestion['sources'] }): string => {
  const ref = (item.sources ?? (item.sourceRefs as QuizQuestion['sources']))?.[0];
  return ref ? `${ref.sourceId}:${ref.unit}` : '';
};

const sameCard = (front: string) => front.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export async function generateCards(
  ctx: StudyContext,
  src: GenSource,
  options: CardOptions & RunOptions & { limit?: number; existingFronts?: string[] } = {},
  progress: (text: string) => void = () => {},
): Promise<{ title: string; cards: NewCard[]; skipped: string[] }> {
  const size = options.size ?? 'standard';
  const gen = (system: string, user: string, tool: GenTool) => generated(system, user, tool, options.meter, options.stop);
  let max = Math.min(MAX_ITEMS, options.limit ?? CEILING[size]);
  const seen = new Set((options.existingFronts ?? []).map(sameCard));
  const groups: Tagged<NewCard>[][] = [];
  const skipped: string[] = [];
  let title = '';

  const keep = (into: Tagged<NewCard>[], raw: RawQuestion, ref: QuizQuestion['sources'] | null) => {
    if (ref === null) return;
    const front = String(raw.front ?? '').trim();
    const back = String(raw.back ?? '').trim();
    const key = sameCard(front);
    if (!front || !back || !key || seen.has(key)) return;
    seen.add(key);
    into.push({ item: { front, back, topic: String(raw.topic ?? '').trim(), ...(ref ? { sourceRefs: ref } : {}) }, core: isCoreTag(raw) });
  };

  const walking = await resolveWalk(ctx, src, options.walk ?? 'auto', 'cards', progress, options.meter, options.stop);
  const { walk, brief } = walking ? await prepareWalk('cards', src, progress, options.meter, options.stop) : { walk: [] as WalkSource[], brief: null };
  const limit = options.limit ?? brief?.count;
  const collect = !!brief?.everyItem && !limit;
  const cardsSystem = withInstructions(CARDS_SYSTEM, brief?.text ?? '', 'cards');
  if (walk.length) {
    const plan = walkPlan(walk, options.fast ?? true);
    const { windows } = plan;
    max = collect ? MAX_ITEMS : budgetFor(windows, size, limit);
    let done = 0;
    progress(`Reading ${walk.length === 1 ? walk[0].title : `${walk.length} sources`} page by page - ${windows.length} passes`);
    const results = await inOrder(windows, plan.parallel, async (window) => {
      const prompt = (w: Window, extra = '') => passPrompt(
        ctx, plan.material(w), w, 'cards',
        size, cardStyle(ctx, options) + extra, brief,
        windows, limit, plan.fast,
      );
      let why = '';
      const args = await gen(cardsSystem, prompt(window), CARDS_TOOL).catch((e) => { unlessStopped(e); why = errorText(e); return null; });
      if (!args) {
        done += 1;
        progress(`${window.sourceTitle}, ${pagesLabel(window)}: could not be written - ${why} (${done} of ${windows.length} passes)`);
        return { window, group: null as Tagged<NewCard>[] | null, title: '' };
      }
      const group: Tagged<NewCard>[] = [];
      for (const r of (args.cards as RawQuestion[] | undefined) ?? []) keep(group, r, pageRef(r, window));
      const gap = chaseGaps(brief) ? uncovered(window, new Set(group.map((t) => pageKey(t.item)))) : null;
      if (gap) {
        progress(`${window.sourceTitle}, ${pagesLabel(gap)}: not covered yet, writing them now…`);
        const more = await gen(cardsSystem, prompt(gap, MISSED_NOTE), CARDS_TOOL).catch(unlessStopped);
        for (const r of (more?.cards as RawQuestion[] | undefined) ?? []) keep(group, r, pageRef(r, gap));
      }
      done += 1;
      progress(`${window.sourceTitle}, ${pagesLabel(window)}: ${group.length} card${group.length === 1 ? '' : 's'} (${done} of ${windows.length} passes)`);
      return { window, group: inPageOrder(group), title: String(args.title ?? '').trim() };
    });
    for (const { window, group, title: named } of results) {
      if (!group) { skipped.push(`${window.sourceTitle}, ${pagesLabel(window)}`); continue; }
      title ||= named;
      groups.push(group);
    }
  } else {
    const text = instructionsOf(src);
    const count = options.limit ?? DIRECT_CARD_COUNT[size];
    max = text && !options.limit ? MAX_ITEMS : Math.min(MAX_ITEMS, count);
    progress(text ? 'Writing the cards…' : `Writing ${count} cards…`);
    const fronts = options.existingFronts ?? [];
    const avoid = fronts.length ? `\n\nThe notebook already has cards with these fronts; do not repeat them:\n${fronts.slice(-150).map((f) => `- ${f}`).join('\n')}` : '';
    const ask = `Write ${count} flashcards${text && !options.limit ? " - or, where the student's instructions call for a particular number or for every item of some kind, exactly what they call for" : ''}.`;
    const args = await gen(
      withInstructions(CARDS_DIRECT_SYSTEM, text, 'cards'),
      `${contextBlock(ctx)}\n\n${describeSource(directSource(src))}\n\n${ask}${avoid}\n\n${cardStyle(ctx, options)}${reminderOf(text, 'cards')}`,
      CARDS_TOOL,
    );
    title = String(args.title ?? '').trim();
    const group: Tagged<NewCard>[] = [];
    for (const r of (args.cards as RawQuestion[] | undefined) ?? []) keep(group, r, provenance(r, src));
    groups.push(group);
  }

  if (!groups.some((g) => g.length)) throw new Error(skipped.length ? 'None of the passes over the material could be written. Try again.' : 'No new cards came back. Try a different prompt.');
  const all = walking && size === 'fewer' && !collect ? coreOnly(groups.flat(), (t) => pageKey(t.item), (t) => t.core) : groups.flat();
  const kept = balancedTrim(all, (t) => pageKey(t.item), max, (t) => t.core).map((t) => t.item);
  if (walk.length) {
    options.stop?.throwIfStopped();
    progress('Naming the deck…');
    title = await nameIt('deck', walk, kept.map((c) => c.topic ?? ''), title || 'Flashcards', options.meter);
  }
  return { title: title || 'Flashcards', cards: kept, skipped };
}

export async function generateTitle(question: string, answer: string): Promise<string | null> {
  const args = await generateQuick<{ title?: unknown }>({
    feature: 'chat',
    system: 'Name this conversation like a good document title: 2 to 6 words, specific, no quotes, no final full stop, never "Question about".',
    instruction: `User: ${question.slice(0, 1500)}\n\nAssistant: ${answer.slice(0, 1500)}`,
    schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
  }).catch(unlessStopped);
  const title = String(args?.title ?? '').trim().replace(/^["'#*\s]+|["'.*\s]+$/g, '');
  return title ? title.slice(0, 80) : null;
}

export const cardsFromMistakes = (items: { prompt: string; answer: string; explanation: string; topic: string }[]): NewCard[] =>
  items.map((m) => ({ front: m.prompt, back: `**${m.answer}**${m.explanation ? `\n\n${m.explanation}` : ''}`, topic: m.topic }));

export { checkAgrees, defaultTolerance, fillsTheGap, gradeLocal, labelAnswers, labelResults, parseNumber, picked, shuffleChoices, unpick, usableHint } from './quizRules';

const QUIZ_TOOL = {
  type: 'function',
  function: {
    name: 'save_quiz',
    description: 'Save the quiz.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: `A name for the quiz: ${TITLE_RULE}` },
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['mcq', 'multi', 'tf', 'numeric', 'short', 'blank'], description: 'How the question is really answered. short for anything to explain, justify or prove - a true/false statement that needs a proof is short, not tf.' },
              prompt: { type: 'string', description: 'The question. Markdown; maths in $...$. blank: one sentence with exactly one gap written as _____ (five underscores), outside any $…$.' },
              choices: { type: 'array', items: { type: 'string' }, description: 'mcq and multi: 4–6 options. Distractors must be plausible and from the same topic as the answer - never obviously silly, never a different kind of thing.' },
              answer: { type: 'string', description: 'mcq: 0-based index of the right choice. tf: "true" or "false". numeric: the number only (no units). short: a model answer - for a prove-or-disprove statement, the verdict ("True." / "False.") and then the complete proof or counterexample. blank: exactly the word or phrase that fills the gap. Required for every type except multi, which uses answers.' },
              answers: { type: 'array', items: { type: 'number' }, description: 'multi only: the 0-based indexes of every correct choice (at least two).' },
              accept: { type: 'array', items: { type: 'string' }, description: 'blank only: other spellings, plurals or equivalent forms that should count as right.' },
              hint: { type: 'string', description: 'A nudge that helps the student reason or recall: point at the idea, the rule or where to look. It must NOT name the answer, name the correct option, or rule options out one by one. Required for every question.' },
              difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'], description: 'How hard this question is.' },
              tolerance: { type: 'number', description: 'numeric only: accepted absolute error.' },
              unit: { type: 'string', description: 'numeric only: unit the answer is given in, if any.' },
              explanation: { type: 'string', description: 'Worked solution shown after answering. Markdown; maths in $...$. Required for every question.' },
              topic: { type: 'string', description: 'Short topic name.' },
              importance: { type: 'string', enum: ['core', 'detail'], description: 'core: needed to pass the exam on this material. detail: worth knowing, but supporting.' },
              check_code: {
                type: 'string',
                description: 'Python that derives the correct answer independently and prints it as the LAST line: mcq → the 0-based index, multi → the indexes separated by commas, tf → True/False, numeric → the number in the stated unit, blank → the word or phrase, short → only for a prove-or-disprove statement: True if the statement holds, False if not (test it: search for a counterexample, or verify it symbolically). sympy (sp), numpy (np), scipy, pint (ureg, Q_) are available. Omit only for purely conceptual questions.',
              },
              figure_code: { type: 'string', description: 'Optional matplotlib code drawing a figure the question needs (graph, diagram). Leave the figure open; it is captured.' },
              from_source: { type: 'string', description: 'When the question came from a given excerpt or note, the exact source title it was taken from, so the student can trace it back. Leave it out for a question written from general knowledge.' },
              from_where: { type: 'string', description: 'Where in that source, exactly as the excerpt is labelled (e.g. "page 12", "slide 4").' },
            },
            required: ['type', 'prompt'],
          },
        },
      },
      required: ['title', 'questions'],
    },
  },
};

type RawQuestion = {
  front?: unknown; back?: unknown;
  type?: unknown; prompt?: unknown; choices?: unknown; answer?: unknown; answers?: unknown; accept?: unknown;
  tolerance?: unknown; unit?: unknown; explanation?: unknown; hint?: unknown; difficulty?: unknown;
  topic?: unknown; check_code?: unknown; figure_code?: unknown; from_source?: unknown; from_where?: unknown;
  importance?: unknown;
};

type Tagged<T> = { item: T; core: boolean };
const isCoreTag = (raw: RawQuestion) => raw.importance !== 'detail';

function provenance(raw: RawQuestion, src: GenSource): QuizQuestion['sources'] {
  const title = String(raw.from_source ?? '').trim();
  if (!title || src.kind !== 'sources') return undefined;
  const where = String(raw.from_where ?? '').trim();
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();
  const hit = src.hits.find((h) => norm(h.sourceTitle) === norm(title))
    ?? src.hits.find((h) => norm(h.sourceTitle).includes(norm(title)) || norm(title).includes(norm(h.sourceTitle)));
  if (hit) return [{ sourceId: hit.sourceId, title: hit.sourceTitle, label: where || hit.label, unit: hit.unitFrom }];
  const note = (src.notes ?? []).find((n) => norm(n.title) === norm(title));
  return note ? [{ sourceId: -note.id, title: note.title, label: where || 'your notes', unit: 0 }] : undefined;
}

const TYPES: QuestionType[] = ['mcq', 'multi', 'tf', 'numeric', 'short', 'blank'];
const LEVELS: Difficulty[] = ['easy', 'medium', 'hard'];

function normalise(q: RawQuestion): (QuizQuestion & { check?: string; figureCode?: string }) | null {
  const type = TYPES.find((t) => t === q.type);
  const prompt = String(q.prompt ?? '').trim();
  if (!type || !prompt) return null;
  const base = {
    type, prompt,
    explanation: String(q.explanation ?? '').trim(),
    hint: String(q.hint ?? '').trim(),
    difficulty: LEVELS.find((l) => l === q.difficulty),
    topic: String(q.topic ?? '').trim() || 'General',
    check: typeof q.check_code === 'string' && q.check_code.trim() ? q.check_code : undefined,
    figureCode: typeof q.figure_code === 'string' && q.figure_code.trim() ? q.figure_code : undefined,
  };
  const choices = Array.isArray(q.choices) ? q.choices.map((c) => String(c).trim()).filter(Boolean) : [];
  if (type === 'mcq') {
    const idx = Number(q.answer);
    if (choices.length < 2 || !Number.isInteger(idx) || idx < 0 || idx >= choices.length) return null;
    return withHint({ ...base, choices, answer: idx });
  }
  if (type === 'multi') {
    const picked = Array.isArray(q.answers)
      ? [...new Set(q.answers.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < choices.length))].sort((a, b) => a - b)
      : [];
    if (choices.length < 3 || picked.length < 2 || picked.length === choices.length) return null;
    return withHint({ ...base, choices, answers: picked, answer: picked.join(',') });
  }
  if (type === 'blank') {
    const answer = String(q.answer ?? '').trim();
    const gaps = prompt.match(/_{2,}|\[ ?\.{3} ?\]|\u2026/g)?.length ?? 0;
    if (!answer || gaps !== 1) return null;
    const accept = Array.isArray(q.accept) ? q.accept.map((a) => String(a).trim()).filter(Boolean).slice(0, 8) : [];
    return withHint({ ...base, answer, accept });
  }
  if (type === 'tf') {
    const a = String(q.answer).trim().toLowerCase();
    if (a !== 'true' && a !== 'false') return null;
    return withHint({ ...base, answer: a });
  }
  if (type === 'numeric') {
    const n = parseNumber(String(q.answer));
    if (n === null) return null;
    const tol = Number(q.tolerance);
    return withHint({ ...base, answer: n, tolerance: Number.isFinite(tol) && tol > 0 ? tol : defaultTolerance(n), unit: String(q.unit ?? '').trim() || undefined });
  }
  const answer = String(q.answer ?? '').trim();
  return answer ? withHint({ ...base, answer }) : null;
}

type Normalised = QuizQuestion & { check?: string; figureCode?: string };

function withHint(q: Normalised): Normalised {
  const hint = usableHint(q.hint ?? '', q);
  return hint ? { ...q, hint } : { ...q, hint: undefined };
}

export { MAX_ITEMS };
export type { CardOptions, CardSize, GenSource };

export type QuizProgress = (text: string) => void;

async function verify(
  q: Normalised,
  python: boolean,
  notebookId: number,
  progress: QuizProgress,
  why: (reason: string) => void = () => {},
): Promise<QuizQuestion | null> {
  const { check, figureCode, ...question } = q;
  if (python && check && canCheck(question)) {
    progress('Checking question %n in Python…');
    const res = await runPython(check, 30).catch(unlessStopped);
    if (!res) { why('the check could not be run at all'); return null; }
    if (!res.ok) { why(`the check failed to run: ${(res.error || res.stderr || '').slice(0, 200)}`); return null; }
    const printed = (res.stdout || res.result || '').trim().split('\n').pop()?.trim() ?? '';
    if (!checkAgrees(question, res.stdout || res.result || '')) {
      why(`the answer key says ${JSON.stringify(question.answers ?? question.answer)} but check_code printed ${JSON.stringify(printed)}`);
      return null;
    }
    question.verified = true;
  } else if (python && question.type === 'numeric') {
    why('it is a numeric question with no check_code, so the answer cannot be trusted');
    return null;
  } else {
    question.verified = false;
  }
  if (python && figureCode) {
    progress('Drawing the figure for question %n…');
    const res = await runPython(figureCode, 30).catch(unlessStopped);
    const fig = res?.figures?.[0];
    if (fig) {
      const saved = await studyApi.attachmentAdd({ notebookId, kind: 'figure', name: fig.name, mime: 'image/png', data: fig.dataUrl });
      question.figure = saved.id;
    }
  }
  return question;
}

export async function rewriteQuestion(
  ctx: StudyContext,
  previous: QuizQuestion,
  notebookId: number,
  src: GenSource,
  progress: QuizProgress = () => {},
  options: QuizOptions = {},
): Promise<QuizQuestion> {
  let python = false;
  try { python = (await pythonStatus()).ready; } catch { python = false; }

  for (let attempt = 0; attempt < 3; attempt++) {
    progress(attempt === 0 ? 'Rewriting the question…' : 'That rewrite failed its check - trying again…');
    const args = await generated(
      QUIZ_DIRECT_SYSTEM,
      `${contextBlock(ctx)}\n\n${describeSource(directSource(src))}\n\nWrite exactly 1 question to replace this one:\n\n` +
      `<replacing type="${previous.type}" topic="${previous.topic}">\n${previous.prompt}\n</replacing>\n\n` +
      'Cover the same idea, but do not write the same question again - ask it a different way, or from a different angle.\n' +
      `${describeOptions({ difficulty: previous.difficulty ?? options.difficulty, types: options.types?.length ? options.types : [previous.type] })}`,
      QUIZ_TOOL,
    );
    const raw = Array.isArray(args.questions) ? (args.questions as RawQuestion[]) : [];
    for (const r of raw) {
      const q = normalise(r);
      if (!q) continue;
      const checked = await verify(q, python, notebookId, progress);
      if (checked) return checked;
    }
  }
  throw new Error('Could not write a replacement that passed its check. Edit it by hand, or try a different topic.');
}

function withDiagrams(questions: QuizQuestion[], diagrams: QuizQuestion[], src: GenSource): QuizQuestion[] {
  if (!diagrams.length) return questions;
  const order = new Map<number, number>();
  if (src.kind === 'sources') src.hits.forEach((h) => { if (!order.has(h.sourceId)) order.set(h.sourceId, order.size); });
  let last = 0;
  const keyed = [...questions, ...diagrams].map((q, i) => {
    const ref = q.sources?.[0];
    const key = ref && order.has(ref.sourceId) ? order.get(ref.sourceId)! * 1e6 + (ref.unit ?? 0) : last;
    last = key;
    return { q, i, key };
  });
  return keyed.sort((a, b) => a.key - b.key || a.i - b.i).map((x) => x.q);
}

export async function generateQuiz(
  ctx: StudyContext,
  src: GenSource,
  notebookId: number,
  progress: QuizProgress,
  options: QuizOptions = {},
): Promise<{ title: string; questions: QuizQuestion[]; dropped: number; skipped: string[] }> {
  let python = false;
  let ocr = false;
  try { const status = await pythonStatus(); python = status.ready; ocr = !!status.ocrReady; } catch { python = false; }
  const gen = (system: string, user: string, tool: GenTool) => generated(system, user, tool, options.meter, options.stop);
  const size = options.size ?? 'standard';
  let diagrams: QuizQuestion[] = [];
  const picks = options.diagramPicks;
  if (options.diagrams && src.kind === 'sources' && src.hits.length && (!picks || picks.length)) {
    if (!python || !ocr) {
      progress('Diagram labelling is not installed, so this quiz has no diagram questions.');
    } else {
      const ids = [...new Set(picks ? picks.map((d) => d.source.id) : src.hits.map((h) => h.sourceId))];
      const known = picks ? picks.map((d) => d.source) : await studyApi.sources(notebookId).catch(() => []);
      const chosen = ids.map((id) => known.find((s) => s.id === id)).filter((s): s is NonNullable<typeof s> => !!s);
      const pages = new Map<number, Map<number, string>>();
      for (const h of src.hits) {
        const m = pages.get(h.sourceId) ?? new Map<number, string>();
        m.set(h.unitFrom, h.text);
        pages.set(h.sourceId, m);
      }
      const texts = src.hits.filter((h) => h.kind !== 'image').map((h) => ({ sourceId: h.sourceId, unit: h.unitFrom, text: h.text }));
      const notes = (src.notes ?? []).map((n) => n.content.replace(/data:[^\s)"']+/g, ''));
      const total = options.limit ?? QUIZ_COUNT[size];
      diagrams = await diagramQuestions(chosen, { texts, notes, pages }, notebookId, MAX_ITEMS, progress, options.meter, options.stop, picks);
      const rest = total - diagrams.length;
      progress(!diagrams.length
        ? 'No diagrams in these sources are about what they teach; writing the usual questions.'
        : rest > 0
          ? `${diagrams.length} diagram question${diagrams.length === 1 ? '' : 's'} ready; writing ${rest} more of the usual kind…`
          : `${diagrams.length} diagram question${diagrams.length === 1 ? '' : 's'} ready.`);
      if (diagrams.length && rest <= 0) {
        const named = await nameIt('quiz', hitsToWalk(src.hits), diagrams.map((q) => q.topic), 'Diagram quiz', options.meter);
        return { title: named, questions: withDiagrams([], diagrams, src), dropped: 0, skipped: [] };
      }
      if (diagrams.length) options = { ...options, limit: rest };
    }
  }
  let max = Math.min(MAX_ITEMS, options.limit ?? QUIZ_COUNT[size]);
  const seen = new Set<string>();
  const skipped: string[] = [];
  let title = '';
  let dropped = 0;

  let allowed = allowedTypes(options, null);
  let checks = 0;

  const settle = async (raw: RawQuestion[], ref: (r: RawQuestion) => QuizQuestion['sources'] | null, cap: number) => {
    const kept: Tagged<QuizQuestion>[] = [];
    const failed: string[] = [];
    for (const r of raw) {
      options.stop?.throwIfStopped();
      if (kept.length >= cap) break;
      const from = ref(r);
      if (from === null) continue;
      const q = normalise(r);
      if (!q) {
        dropped++;
        failed.push(`- ${String(r.prompt ?? '').slice(0, 200)}\n  (it was incomplete: its answer, choices or gap were missing or did not fit its type)`);
        continue;
      }
      const key = sameCard(q.prompt);
      if (seen.has(key)) continue;
      if (allowed && !allowed.includes(q.type)) {
        dropped++;
        failed.push(`- ${q.prompt.slice(0, 200)}\n  (it is ${TYPE_LABEL[q.type]}, but only ${allowed.map((t) => TYPE_LABEL[t]).join(', ')} were asked for)`);
        continue;
      }
      let reason = 'it did not pass its check';
      const n = ++checks;
      const checked = await verify(q, python, notebookId, (t) => progress(t.replace('%n', String(n))), (why) => { reason = why; });
      if (!checked) {
        dropped++;
        failed.push(`- ${q.prompt.slice(0, 200)}\n  (${reason})`);
        continue;
      }
      seen.add(key);
      const shuffled = shuffleChoices(checked);
      kept.push({ item: from ? { ...shuffled, sources: from } : shuffled, core: isCoreTag(r) });
    }
    return { kept, failed };
  };

  const retryNote = (failed: string[]) => failed.length
    ? '\n\nSome questions you wrote were thrown away, for the reason given after each. Write replacements - different questions on the same material - that fix those reasons; where the reason is the check, make sure each check_code really works out the answer you mark as correct:\n' + failed.join('\n')
    : '';

  const walking = await resolveWalk(ctx, src, options.walk ?? 'auto', 'questions', progress, options.meter, options.stop);
  const { walk, brief } = walking ? await prepareWalk('questions', src, progress, options.meter, options.stop) : { walk: [] as WalkSource[], brief: null };
  allowed = allowedTypes(options, brief);
  const limit = options.limit ?? brief?.count;
  const collect = !!brief?.everyItem && !limit;
  if (limit) max = Math.min(MAX_ITEMS, limit);
  const quizSystem = withInstructions(QUIZ_SYSTEM, brief?.text ?? '', 'questions');
  const groups: Tagged<QuizQuestion>[][] = [];

  if (walk.length) {
    const plan = walkPlan(walk, options.fast ?? true);
    const { windows } = plan;
    max = collect ? MAX_ITEMS : budgetFor(windows, size, limit, 'questions');
    let done = 0;
    progress(`Reading ${walk.length === 1 ? walk[0].title : `${walk.length} sources`} page by page - ${windows.length} passes`);
    const results = await inOrder(windows, plan.parallel, async (window) => {
      const base = passPrompt(
        ctx, plan.material(window), window, 'questions',
        size, describeOptions(options, brief), brief,
        windows, limit, plan.fast,
      );
      const ref = (r: RawQuestion) => pageRef(r, window);
      let why = '';
      const args = await gen(quizSystem, base, QUIZ_TOOL).catch((e) => { unlessStopped(e); why = errorText(e); return null; });
      if (!args) {
        done += 1;
        progress(`${window.sourceTitle}, ${pagesLabel(window)}: could not be written - ${why} (${done} of ${windows.length} passes)`);
        return { window, kept: null as Tagged<QuizQuestion>[] | null, title: '' };
      }
      const room = collect ? MAX_ITEMS : expectedItems(window, windows, size, limit, plan.fast, 'questions') * 2 + 2;
      const first = await settle((args.questions as RawQuestion[] | undefined) ?? [], ref, room);
      let kept = first.kept;
      if (first.failed.length && kept.length < room) {
        const again = await gen(quizSystem, base + retryNote(first.failed), QUIZ_TOOL).catch(unlessStopped);
        if (again) {
          const second = await settle((again.questions as RawQuestion[] | undefined) ?? [], ref, room - kept.length);
          kept = [...kept, ...second.kept];
        }
      }
      const gap = chaseGaps(brief) ? uncovered(window, new Set(kept.map((t) => pageKey(t.item)))) : null;
      if (gap) {
        progress(`${window.sourceTitle}, ${pagesLabel(gap)}: not covered yet, writing them now…`);
        const prompt = passPrompt(
          ctx, plan.material(gap), gap, 'questions',
          size, describeOptions(options, brief) + MISSED_NOTE, brief,
          windows, limit, plan.fast,
        );
        const more = await gen(quizSystem, prompt, QUIZ_TOOL).catch(unlessStopped);
        if (more) {
          const room = collect ? MAX_ITEMS : expectedItems(gap, windows, size, limit, plan.fast, 'questions') * 2 + 2;
          kept = [...kept, ...(await settle((more.questions as RawQuestion[] | undefined) ?? [], (r) => pageRef(r, gap), room)).kept];
        }
      }
      done += 1;
      progress(`${window.sourceTitle}, ${pagesLabel(window)}: ${kept.length} question${kept.length === 1 ? '' : 's'} (${done} of ${windows.length} passes)`);
      return { window, kept: inPageOrder(kept), title: String(args.title ?? '').trim() };
    });
    for (const { window, kept, title: named } of results) {
      if (!kept) { skipped.push(`${window.sourceTitle}, ${pagesLabel(window)}`); continue; }
      title ||= named;
      groups.push(kept);
    }
  } else {
    const text = instructionsOf(src);
    const count = max;
    if (text && !options.limit) max = MAX_ITEMS;
    const system = withInstructions(QUIZ_DIRECT_SYSTEM, text, 'questions');
    const base = `${contextBlock(ctx)}\n\n${describeSource(directSource(src))}\n\n${describeOptions(options)}`;
    const ref = (r: RawQuestion) => provenance(r, src);
    const group: Tagged<QuizQuestion>[] = [];
    let failed: string[] = [];
    let need = count;
    for (let round = 0; round < 3 && need > 0; round++) {
      options.stop?.throwIfStopped();
      progress(round === 0
        ? (text ? 'Writing the questions…' : `Writing ${need} questions…`)
        : `Replacing ${need} question${need === 1 ? '' : 's'} that failed their check…`);
      const ask = round === 0
        ? `Write ${need} questions${text && !options.limit ? " - or, where the student's instructions call for a particular number or for every item of some kind, exactly what they call for" : ''}.`
        : `Write ${need} question${need === 1 ? '' : 's'}.${retryNote(failed)}\n\nThese are already in the quiz; do not repeat them:\n${group.map((t) => `- ${t.item.prompt.slice(0, 160)}`).join('\n')}`;
      const args = await gen(system, `${base}\n\n${ask}${reminderOf(text, 'questions')}`, QUIZ_TOOL)
        .catch((e) => { if (round === 0) throw e; return unlessStopped(e); });
      if (!args) break;
      title ||= String(args.title ?? '').trim();
      const settled = await settle((args.questions as RawQuestion[] | undefined) ?? [], ref, round === 0 ? max : need);
      group.push(...settled.kept);
      failed = settled.failed;
      need = text && !options.limit ? Math.min(failed.length, max - group.length) : Math.min(count - group.length, max - group.length);
    }
    groups.push(group);
  }

  if (!groups.some((g) => g.length)) throw new Error('No question passed its check. Try again or narrow the topic.');
  let all = walking && size === 'fewer' && !collect ? coreOnly(groups.flat(), (t) => pageKey(t.item), (t) => t.core) : groups.flat();

  for (let attempt = 0; attempt < 2 && walking && !collect && all.length < max; attempt++) {
    options.stop?.throwIfStopped();
    const need = max - all.length;
    progress(`Writing ${need} more question${need === 1 ? '' : 's'} to make ${max}…`);
    const already = all.map((t) => `- ${t.item.prompt.slice(0, 160)}`).join('\n');
    const ask = `\n\nThe quiz is ${need} question${need === 1 ? '' : 's'} short. Write exactly ${need} more, on the parts of the material the questions below cover least, and different from every one of them:\n${already}`;
    let args: Record<string, unknown> | null;
    let ref: (r: RawQuestion) => QuizQuestion['sources'] | null;
    if (walk.length) {
      const plan = walkPlan(walk, options.fast ?? true);
      const count = (w: Window) => all.filter((t) => w.pages.some((p) => pageKey(t.item) === pageId(p))).length;
      const target = [...plan.windows].sort((a, b) => count(a) / a.chars - count(b) / b.chars)[0];
      const base = passPrompt(ctx, plan.material(target), target, 'questions', size, describeOptions(options, brief), brief, plan.windows, limit, plan.fast);
      args = await gen(quizSystem, base + ask, QUIZ_TOOL).catch(unlessStopped);
      ref = (r) => pageRef(r, target);
    } else {
      args = await gen(QUIZ_SYSTEM, `${contextBlock(ctx)}\n\n${describeSource(src)}\n${describeOptions(options, brief)}${ask}`, QUIZ_TOOL).catch(unlessStopped);
      ref = (r) => provenance(r, src);
    }
    if (!args) break;
    const extra = (await settle((args.questions as RawQuestion[] | undefined) ?? [], ref, need)).kept;
    if (!extra.length) break;
    const at = new Map(walk.map((w, i) => [w.id, i]));
    const key = (t: Tagged<QuizQuestion>) => { const r = t.item.sources?.[0]; return r ? (at.get(r.sourceId) ?? 0) * 1e6 + r.unit : 0; };
    all = [...all, ...extra].map((t, i) => ({ t, i })).sort((a, b) => key(a.t) - key(b.t) || a.i - b.i).map((x) => x.t);
  }
  const kept = balancedTrim(all, (t) => pageKey(t.item), max, (t) => t.core).map((t) => t.item);
  if (walk.length) {
    options.stop?.throwIfStopped();
    progress('Naming the quiz…');
    title = await nameIt('quiz', walk, kept.map((q) => q.topic), title || 'Practice quiz', options.meter);
  }
  return { title: title || 'Practice quiz', questions: withDiagrams(kept, diagrams, src), dropped, skipped };
}

const GRADE_TOOL = {
  type: 'function',
  function: {
    name: 'grade',
    description: 'Grade the answer.',
    parameters: {
      type: 'object',
      properties: {
        correct: { type: 'boolean', description: 'True if the answer is essentially right (same meaning as the reference; wording can differ).' },
        feedback: { type: 'string', description: 'One or two sentences to the student: what was right or missing.' },
      },
      required: ['correct', 'feedback'],
    },
  },
};

export async function gradeShort(q: QuizQuestion, given: string): Promise<{ correct: boolean; feedback: string }> {
  const args = await generated(
    GRADE_SYSTEM,
    `Question: ${q.prompt}\n\nReference answer: ${q.answer}${q.explanation ? `\n\nWorked solution: ${q.explanation}` : ''}\n\nStudent answer: ${given}`,
    GRADE_TOOL,
  );
  return { correct: args.correct === true, feedback: String(args.feedback ?? '') };
}

const GAP_TOOL = {
  type: 'function',
  function: {
    name: 'grade_gap',
    description: 'Say whether the word the strict comparison rejected is the right answer written differently.',
    parameters: {
      type: 'object',
      properties: {
        correct: { type: 'boolean', description: 'True if what the student wrote names the same thing as the reference.' },
        note: { type: 'string', description: 'One sentence to the student, as the instructions describe.' },
      },
      required: ['correct', 'note'],
    },
  },
};

/**
 * Marks a fill-the-gap answer. An exact match (give or take case, accents, articles and plurals)
 * passes without asking; anything else goes to the AI, which can only turn that miss into a pass,
 * never the other way round - so a misspelt right answer counts.
 */
export async function gradeBlank(q: QuizQuestion, given: string): Promise<{ correct: boolean; feedback?: string }> {
  if (fillsTheGap(q, given)) return { correct: true };
  const accept = (q.accept ?? []).filter((a) => a.trim());
  try {
    const args = await generated(
      GAP_GRADE_SYSTEM,
      [
        `Topic: ${q.topic || 'this course'}`,
        `The sentence, with its gap: ${q.prompt}`,
        `Reference: ${q.answer}`,
        accept.length ? `Also accepted: ${accept.join(', ')}` : '',
        `Student wrote: ${given}`,
      ].filter(Boolean).join('\n'),
      GAP_TOOL,
    );
    const note = String(args.note ?? '').trim();
    return { correct: args.correct === true, feedback: note || undefined };
  } catch {
    return { correct: false, feedback: 'This could not be double-checked by the AI, so it was marked on its spelling alone.' };
  }
}

const LABELS_TOOL = {
  type: 'function',
  function: {
    name: 'grade_labels',
    description: 'Mark each label the strict comparison rejected, and say why.',
    parameters: {
      type: 'object',
      properties: {
        labels: {
          type: 'array',
          description: 'One entry per label you were given, in the same order.',
          items: {
            type: 'object',
            properties: {
              n: { type: 'number', description: 'The label number exactly as it was given to you.' },
              correct: { type: 'boolean', description: 'True if what the student typed names the same thing as the reference label.' },
              note: {
                type: 'string',
                description: 'When correct: two or three words for why it counts, e.g. "synonym", "abbreviation", "spelling slip". When incorrect: one sentence to the student saying what the thing they named actually is and how it differs from the right label, which they can already see beside their answer.',
              },
            },
            required: ['n', 'correct', 'note'],
          },
        },
      },
      required: ['labels'],
    },
  },
};

export type LabelGrade = {
  results: boolean[];
  /** Per box: why it was accepted, or what the student named instead. '' where there is nothing to say. */
  notes: string[];
  /** Set only when the student should know the marking itself did not go to plan. */
  feedback?: string;
};

/**
 * Marks a labelled diagram. Every label is matched locally first; only the ones that
 * miss - and that the student actually typed something into - go to the AI, which says
 * whether each is the same answer under another name. The AI can only turn a local miss
 * into a pass, never the other way round.
 */
export async function gradeLabels(q: QuizQuestion, given: string): Promise<LabelGrade> {
  const results = labelResults(q, given);
  const labels = q.diagram?.labels ?? [];
  const typed = labelAnswers(given, results.length);
  const doubtful = results
    .map((_ok, i) => i)
    .filter((i) => !results[i] && typed[i].trim() && labels[i]?.answer.trim());
  const silent = results.map(() => '');
  if (!doubtful.length) return { results, notes: silent };

  const asked = doubtful.map((i) => {
    const accept = labels[i].accept?.filter((a) => a.trim()) ?? [];
    return [
      `Label ${i + 1}`,
      `  reference: ${labels[i].answer}`,
      accept.length ? `  also accepted: ${accept.join(', ')}` : '',
      `  student typed: ${typed[i].trim()}`,
    ].filter(Boolean).join('\n');
  });

  try {
    const args = await generated(
      LABELS_GRADE_SYSTEM,
      `The diagram is labelled for this question, on ${q.topic || 'this topic'}:\n${q.prompt}\n\nMark these labels:\n\n${asked.join('\n\n')}`,
      LABELS_TOOL,
    );
    const marked = new Map<number, { correct: boolean; note: string }>();
    for (const entry of Array.isArray(args.labels) ? args.labels : []) {
      const row = entry as { n?: unknown; correct?: unknown; note?: unknown };
      const n = Number(row.n) - 1;
      if (doubtful.includes(n)) marked.set(n, { correct: row.correct === true, note: String(row.note ?? '').trim() });
    }
    return {
      results: results.map((ok, i) => ok || marked.get(i)?.correct === true),
      notes: results.map((_ok, i) => marked.get(i)?.note ?? ''),
    };
  } catch {
    return {
      results,
      notes: silent,
      feedback: 'The near misses could not be double-checked by the AI, so they were marked on their wording alone.',
    };
  }
}
