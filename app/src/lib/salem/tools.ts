import { invoke } from '@tauri-apps/api/core';
import { appTools, APP_TOOL_DEFS } from '../assistant';
import { studyApi } from '../../study/api';
import { htmlToMarkdown, htmlToText, markdownToHtml, padApi } from '../pad';
import type { Route } from '../../study/pages';
import type { NotebookSummary, SubjectNode } from '../../study/api';
import type { SalemTool, ToolInput, ToolOutcome } from './types';

export type ToolEnv = {
  tree: () => SubjectNode[];
  refresh: () => Promise<SubjectNode[]>;
  open: (route: Route) => void;
  notebookId?: number | null;
  sourceIds?: number[];
};

const META: Record<string, { scopes: string[]; mutating?: boolean; label: string }> = {
  list_study: { scopes: ['study'], label: 'Looking through your study space' },
  read_syllabus: { scopes: ['study'], label: 'Reading the syllabus' },
  list_notebook: { scopes: ['study', 'notebooks'], label: 'Looking inside the notebook' },
  search_notebook: { scopes: ['search', 'sources', 'notebooks'], label: 'Searching the notebook' },
  create_subject: { scopes: ['study'], mutating: true, label: 'Creating a subject' },
  create_notebook: { scopes: ['study', 'notebooks'], mutating: true, label: 'Creating a notebook' },
  write_notes: { scopes: ['notes'], mutating: true, label: 'Writing notes' },
  save_note: { scopes: ['notes'], mutating: true, label: 'Saving a note' },
  make_flashcards: { scopes: ['cards'], mutating: true, label: 'Making flashcards' },
  make_quiz: { scopes: ['quizzes'], mutating: true, label: 'Making a quiz' },
  timer: { scopes: ['ui'], mutating: true, label: 'Setting the focus timer' },
  add_tasks: { scopes: ['ui'], mutating: true, label: 'Adding focus tasks' },
  list_events: { scopes: ['schedule'], label: 'Checking the calendar' },
  add_event: { scopes: ['schedule'], mutating: true, label: 'Adding an event' },
  update_event: { scopes: ['schedule'], mutating: true, label: 'Updating an event' },
  delete_event: { scopes: ['schedule'], mutating: true, label: 'Deleting an event' },
  open: { scopes: ['ui'], label: 'Opening a view' },
};

type FunctionDef = {
  function: {
    name: string;
    description: string;
    parameters: { properties: Record<string, Record<string, unknown>>; required?: string[] };
  };
};

function convert(def: FunctionDef): { name: string; description: string; inputs: Record<string, ToolInput> } {
  const { name, description, parameters } = def.function;
  const required = new Set(parameters.required ?? []);
  const inputs: Record<string, ToolInput> = {};
  for (const [key, raw] of Object.entries(parameters.properties ?? {})) {
    const type = String(raw.type ?? 'string');
    inputs[key] = {
      type: (['string', 'number', 'integer', 'boolean', 'array', 'object'].includes(type) ? type : 'string') as ToolInput['type'],
      description: String(raw.description ?? key),
      ...(required.has(key) ? {} : { nullable: true }),
      ...(Array.isArray(raw.enum) ? { enum: raw.enum.map(String) } : {}),
      ...(raw.items ? { items: { type: String((raw.items as { type?: unknown }).type ?? 'string') } } : {}),
    };
  }
  return { name, description, inputs };
}

const NATIVE: SalemTool[] = [
  {
    name: 'run_python',
    description:
      'Run Python in the app\'s sandbox and get its real output back. Use it for every calculation and for anything structured - parsing, dates, tables, statistics, checking an answer. sympy (sp), numpy (np), mpmath (mp), scipy, pymupdf and matplotlib are installed. No network, no files outside the sandbox. print() what you need; nothing carries over between calls.',
    inputs: { code: { type: 'string', description: 'The Python to run. print() every value you need.' } },
    outputType: 'object',
    scopes: ['python'],
    label: 'Running Python',
    state: 'running_python',
    timeout: 180,
  },
  {
    name: 'web_search',
    description:
      'Search the web and get back titles, URLs and snippets. Use it whenever the answer depends on something current, changing or checkable, or when you are not sure.',
    inputs: {
      query: { type: 'string', description: 'What to search for.' },
      count: { type: 'integer', description: 'How many results (1–15, default 6).', nullable: true },
    },
    outputType: 'array',
    scopes: ['web'],
    label: 'Searching the web',
    state: 'retrieving',
    timeout: 60,
  },
  {
    name: 'web_fetch',
    description: 'Read a web page and get its text back. Use it on a result from web_search when the snippet is not enough.',
    inputs: {
      url: { type: 'string', description: 'The page to read (http or https).' },
      maxChars: { type: 'integer', description: 'How much text to return (default 12000).', nullable: true },
    },
    outputType: 'object',
    scopes: ['web'],
    label: 'Reading a page',
    state: 'retrieving',
    timeout: 60,
  },
];

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text);

async function allowed(env: ToolEnv): Promise<number[]> {
  if (env.sourceIds?.length) return env.sourceIds;
  if (env.notebookId == null) return [];
  const sources = await studyApi.sources(env.notebookId);
  return sources.filter((s) => s.status === 'ready').map((s) => s.id);
}

function sourceTools(env: ToolEnv): SalemTool[] {
  return [
    {
      name: 'list_sources',
      description: 'List the sources you are allowed to read, with their kind and how many pages or slides each has. Look here before searching so you know what exists.',
      inputs: {},
      outputType: 'array',
      scopes: ['sources'],
      label: 'Listing the sources',
      state: 'retrieving',
      async run() {
        const ids = await allowed(env);
        if (!ids.length) return { result: [], detail: 'no sources' };
        const all = env.notebookId == null ? [] : await studyApi.sources(env.notebookId);
        const mine = all.filter((s) => ids.includes(s.id));
        return {
          result: mine.map((s) => ({ id: s.id, title: s.title, kind: s.kind, units: s.unitCount, characters: s.charCount })),
          detail: `${mine.length} source${mine.length === 1 ? '' : 's'}`,
        };
      },
    },
    {
      name: 'search_sources',
      description:
        'Search the sources you are allowed to read and get back the matching passages with their source and page. Search again with different words if what comes back does not answer the question.',
      inputs: {
        query: { type: 'string', description: 'What to look for. Use the words the source would use.' },
        limit: { type: 'integer', description: 'How many passages (1–20, default 8).', nullable: true },
        sourceId: { type: 'integer', description: 'Restrict to one source, by id from list_sources.', nullable: true },
      },
      outputType: 'array',
      scopes: ['sources', 'search'],
      label: 'Searching the sources',
      state: 'retrieving',
      async run(args) {
        const ids = await allowed(env);
        const only = Number(args.sourceId);
        const scope = Number.isFinite(only) && only > 0 ? ids.filter((id) => id === only) : ids;
        if (Number.isFinite(only) && only > 0 && !scope.length) {
          throw new Error(`Source ${only} is not one of the sources this question may use (${ids.join(', ') || 'none'}).`);
        }
        if (!scope.length) return { result: [], detail: 'no sources to search' };
        const limit = Math.min(20, Math.max(1, Number(args.limit) || 8));
        const hits = await studyApi.searchSources(scope, String(args.query ?? ''), limit);
        return {
          result: hits.map((h) => ({
            sourceId: h.sourceId, source: h.sourceTitle, where: h.label,
            page: h.unitFrom, text: clip(h.text, 2500),
          })),
          detail: `${hits.length} passage${hits.length === 1 ? '' : 's'}`,
        };
      },
    },
    {
      name: 'read_source',
      description:
        'Read a source in order, page by page or slide by slide - not just the passages a search returned. Use it whenever a search hit needs its surroundings, when the student asks about "the lecture" as a whole, or when the excerpts do not answer the question. You can call it again and again to page through an entire document: read 1–20, then 21–40, and so on until you have what you need.',
      inputs: {
        sourceId: { type: 'integer', description: 'The source id, from list_sources.' },
        from: { type: 'integer', description: 'First page/slide number (1-based). Defaults to 1.', nullable: true },
        to: { type: 'integer', description: 'Last page/slide number, inclusive. Defaults to 20 pages on; at most 60 in one call.', nullable: true },
      },
      outputType: 'array',
      scopes: ['sources'],
      label: 'Reading a source',
      state: 'retrieving',
      async run(args) {
        const ids = await allowed(env);
        const id = Number(args.sourceId);
        if (!ids.includes(id)) {
          throw new Error(`Source ${id} is not one this question may use. Allowed: ${ids.join(', ') || 'none'}.`);
        }
        const units = await studyApi.sourceUnits(id);
        const from = Math.max(1, Number(args.from) || 1);
        const to = Math.min(from + 59, Number(args.to) || from + 19);
        const slice = units.filter((u) => u.ord >= from && u.ord <= to);
        return {
          result: slice.sort((a, b) => a.ord - b.ord).map((u) => ({ page: u.ord, label: u.label, text: clip(u.text, 6000) })),
          detail: slice.length
            ? `pages ${from}–${Math.min(to, units.length)} of ${units.length}${to < units.length ? ' - call again for the rest' : ''}`
            : `this source has ${units.length} pages; ${from} is past the end`,
        };
      },
    },
  ];
}

function reachableNotebooks(env: ToolEnv): { id: number; name: string; subject: string }[] {
  const all = env.tree().flatMap((s) => s.notebooks.map((n) => ({ id: n.id, name: n.name, subject: s.name })));
  return env.notebookId == null ? all : all.filter((n) => n.id === env.notebookId);
}

function madeTools(env: ToolEnv): SalemTool[] {
  return [
    {
      name: 'list_study_material',
      description:
        "List the quizzes and flashcard decks the student has made, with their ids. Look here when they mention 'the quiz', 'my deck' or 'that question' - it is usually quicker and more accurate than guessing what they meant.",
      inputs: {},
      outputType: 'object',
      scopes: ['quizzes', 'cards', 'study'],
      label: 'Listing your quizzes and decks',
      state: 'retrieving',
      async run() {
        const books = reachableNotebooks(env);
        const out = await Promise.all(books.map(async (book) => {
          const [quizzes, decks] = await Promise.all([
            studyApi.quizzes(book.id).catch(() => []),
            studyApi.decks(book.id).catch(() => []),
          ]);
          return {
            notebook: `${book.subject} / ${book.name}`,
            quizzes: quizzes.map((q) => ({ id: q.id, title: q.title, questions: q.questionCount })),
            decks: decks.map((d) => ({ id: d.id, title: d.title, cards: d.cardCount })),
          };
        }));
        const kept = out.filter((x) => x.quizzes.length || x.decks.length);
        return { result: kept, detail: `${kept.reduce((n, x) => n + x.quizzes.length + x.decks.length, 0)} item(s)` };
      },
    },
    {
      name: 'read_quiz',
      description:
        'Read a quiz the student made: its questions, the choices, the right answers, the hints and the explanations. Use it when they ask about a question, want to revise from the quiz, or want more questions like it.',
      inputs: {
        quizId: { type: 'integer', description: 'The quiz id, from list_study_material.' },
        question: { type: 'integer', description: 'Only this question (1-based). Leave out for all of them.', nullable: true },
      },
      outputType: 'object',
      scopes: ['quizzes'],
      label: 'Reading a quiz',
      state: 'retrieving',
      async run(args) {
        const id = Number(args.quizId);
        const books = new Set(reachableNotebooks(env).map((b) => b.id));
        const quiz = await studyApi.quiz(id);
        if (!books.has(quiz.notebookId)) {
          throw new Error(`Quiz ${id} is not in a notebook this question may read.`);
        }
        const only = Number(args.question);
        const pick = Number.isFinite(only) && only > 0 ? [quiz.questions[only - 1]].filter(Boolean) : quiz.questions;
        return {
          result: {
            title: quiz.title,
            questions: pick.map((q, i) => ({
              number: Number.isFinite(only) && only > 0 ? only : i + 1,
              type: q.type,
              topic: q.topic,
              difficulty: q.difficulty,
              prompt: q.prompt,
              choices: q.choices,
              answer: q.type === 'multi' ? q.answers : q.answer,
              hint: q.hint,
              explanation: q.explanation,
              from: q.sources?.map((x) => `${x.title} (${x.label})`),
            })),
          },
          detail: `${quiz.title} · ${pick.length} question${pick.length === 1 ? '' : 's'}`,
        };
      },
    },
    {
      name: 'read_deck',
      description:
        "Read a flashcard deck the student made: the front and back of every card, and how they have done on each. Use it when they ask about a card, want the deck explained, or want to know what they keep getting wrong.",
      inputs: { deckId: { type: 'integer', description: 'The deck id, from list_study_material.' } },
      outputType: 'object',
      scopes: ['cards'],
      label: 'Reading a deck',
      state: 'retrieving',
      async run(args) {
        const id = Number(args.deckId);
        const books = reachableNotebooks(env);
        const cards = await studyApi.deckCards(id);
        if (!cards.length) return { result: { cards: [] }, detail: 'the deck is empty' };
        if (!books.some((b) => b.id === cards[0].notebookId)) {
          throw new Error(`Deck ${id} is not in a notebook this question may read.`);
        }
        return {
          result: {
            cards: cards.map((c) => ({
              id: c.id, front: c.front, back: c.back, topic: c.topic,
              seen: c.reviews, missed: c.misses, lastCorrect: c.lastCorrect,
            })),
          },
          detail: `${cards.length} card${cards.length === 1 ? '' : 's'}`,
        };
      },
    },
  ];
}

function intoUnits(text: string): { label: string; text: string }[] {
  const body = text.replace(/\r\n/g, '\n').trim();
  if (!body) return [];
  const parts = body.split(/\n(?=#{1,3} )/g).filter((p) => p.trim());
  if (parts.length > 1) {
    return parts.map((part, i) => ({
      label: part.match(/^#{1,3} (.+)$/m)?.[1]?.trim().slice(0, 80) ?? `Section ${i + 1}`,
      text: part.trim(),
    }));
  }
  const paragraphs = body.split(/\n{2,}/).filter((p) => p.trim());
  const units: { label: string; text: string }[] = [];
  let buffer = '';
  for (const paragraph of paragraphs) {
    if (buffer.length + paragraph.length > 3000 && buffer) {
      units.push({ label: `Part ${units.length + 1}`, text: buffer.trim() });
      buffer = '';
    }
    buffer += `${paragraph}\n\n`;
  }
  if (buffer.trim()) units.push({ label: `Part ${units.length + 1}`, text: buffer.trim() });
  return units;
}

function materialTools(env: ToolEnv): SalemTool[] {
  return [
    {
      name: 'add_source',
      description:
        "Save written material into one of the student's notebooks as a source, so it can be searched, cited, and used to make notes, flashcards and quizzes later. Use it for something you looked up on the web, a summary you wrote for them, or text they pasted into the chat. Say where it came from in the title.",
      inputs: {
        notebook: { type: 'string', description: 'Notebook name as the student says it; "Subject / Notebook" if the name is ambiguous.' },
        title: { type: 'string', description: 'What to call it - specific enough to recognise later, e.g. "Krebs cycle - Khan Academy".' },
        content: { type: 'string', description: 'The material itself, as Markdown. Use headings; they become the sections the student can jump to.' },
        url: { type: 'string', description: 'Where it came from, if anywhere.', nullable: true },
      },
      outputType: 'object',
      scopes: ['sources', 'notebooks'],
      mutating: true,
      label: 'Adding a source',
      timeout: 120,
      async run(args) {
        const tree = env.tree();
        const name = String(args.notebook ?? '').trim();
        const all = tree.flatMap((s) => s.notebooks.map((n) => ({ n, s })));
        const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        const wanted = norm(name);
        const exact = all.filter((x) => norm(x.n.name) === wanted || norm(`${x.s.name} ${x.n.name}`) === wanted);
        const hits = exact.length ? exact : all.filter((x) => norm(x.n.name).includes(wanted) || wanted.includes(norm(x.n.name)));
        if (!hits.length) {
          throw new Error(`No notebook called "${name}". The ones that exist are: ${all.map((x) => `${x.s.name} / ${x.n.name}`).join(', ') || 'none yet'}.`);
        }
        if (hits.length > 1) {
          throw new Error(`"${name}" matches several notebooks: ${hits.map((x) => `${x.s.name} / ${x.n.name}`).join(', ')}. Say which.`);
        }
        const target = hits[0];
        const title = String(args.title ?? '').trim().slice(0, 200);
        const content = String(args.content ?? '').trim();
        if (!title) throw new Error('add_source needs a title.');
        const units = intoUnits(content);
        if (!units.length) throw new Error('add_source needs some content to save.');

        const source = await studyApi.addSource({
          notebookId: target.n.id,
          kind: 'text',
          title,
          mime: 'text/markdown',
          url: String(args.url ?? '').trim() || null,
        });
        await studyApi.setSourceContent(source.id, units);
        await studyApi.setSourceStatus(source.id, 'ready');
        await env.refresh();
        return {
          result: { sourceId: source.id, notebook: `${target.s.name} / ${target.n.name}`, sections: units.length },
          label: `Added “${title}” to ${target.n.name}`,
          detail: `${units.length} section${units.length === 1 ? '' : 's'}`,
        };
      },
    },
  ];
}

async function reachableNotes(env: ToolEnv): Promise<{ id: number; notebookId: number; title: string }[]> {
  if (env.notebookId != null) {
    const notes = await studyApi.notes(env.notebookId);
    return notes.map((n) => ({ id: n.id, notebookId: n.notebookId, title: n.title }));
  }
  const tree = env.tree();
  const lists = await Promise.all(
    tree.flatMap((s) => s.notebooks).map(async (n) => (await studyApi.notes(n.id)).map((note) => ({
      id: note.id, notebookId: note.notebookId, title: note.title,
    }))),
  );
  return lists.flat();
}

function noteTools(env: ToolEnv): SalemTool[] {
  return [
    {
      name: 'list_notes',
      description:
        "List the student's own written notes you can read, with their id and which notebook they are in. Their notes are often the best summary of what their course actually covered, so look here before answering from general knowledge.",
      inputs: {},
      outputType: 'array',
      scopes: ['notes'],
      label: 'Listing your notes',
      state: 'retrieving',
      async run() {
        const notes = await reachableNotes(env);
        const tree = env.tree();
        const nameOf = (id: number) => tree.flatMap((s) => s.notebooks.map((n) => ({ n, s }))).find((x) => x.n.id === id);
        return {
          result: notes.map((n) => {
            const where = nameOf(n.notebookId);
            return { id: n.id, title: n.title, notebook: where ? `${where.s.name} / ${where.n.name}` : undefined };
          }),
          detail: `${notes.length} note${notes.length === 1 ? '' : 's'}`,
        };
      },
    },
    {
      name: 'read_note',
      description: "Read one of the student's notes in full, by its id from list_notes. Returns the note as Markdown.",
      inputs: { noteId: { type: 'integer', description: 'The note id, from list_notes.' } },
      outputType: 'object',
      scopes: ['notes'],
      label: 'Reading a note',
      state: 'retrieving',
      async run(args) {
        const id = Number(args.noteId);
        const allowed = await reachableNotes(env);
        if (!allowed.some((n) => n.id === id)) {
          throw new Error(`Note ${id} is not one this question may read. Use list_notes to see which are.`);
        }
        const note = await studyApi.note(id);
        return { result: { id: note.id, title: note.title, content: clip(note.content, 40_000) }, detail: note.title };
      },
    },
    {
      name: 'search_notes',
      description:
        "Search the student's own notes for a word or phrase and get back the matching notes with the passage around each match. Use it when they refer to something they wrote down.",
      inputs: {
        query: { type: 'string', description: 'What to look for.' },
        limit: { type: 'integer', description: 'How many notes to return (1–10, default 5).', nullable: true },
      },
      outputType: 'array',
      scopes: ['notes', 'search'],
      label: 'Searching your notes',
      state: 'retrieving',
      async run(args) {
        const query = String(args.query ?? '').trim().toLowerCase();
        if (!query) throw new Error('search_notes needs something to look for.');
        const limit = Math.min(10, Math.max(1, Number(args.limit) || 5));
        const allowed = await reachableNotes(env);
        const hits: { id: number; title: string; excerpt: string }[] = [];
        for (const meta of allowed) {
          if (hits.length >= limit) break;
          const note = await studyApi.note(meta.id).catch(() => null);
          if (!note) continue;
          const at = note.content.toLowerCase().indexOf(query);
          const inTitle = note.title.toLowerCase().includes(query);
          if (at < 0 && !inTitle) continue;
          const from = at < 0 ? 0 : Math.max(0, at - 400);
          hits.push({ id: note.id, title: note.title, excerpt: clip(note.content.slice(from, from + 1600), 1600) });
        }
        return { result: hits, detail: `${hits.length} note${hits.length === 1 ? '' : 's'}` };
      },
    },
  ];
}

function padTools(env: ToolEnv): SalemTool[] {
  const BY = 'assistant';
  const folderId = async (folder: unknown): Promise<number | null> => {
    if (folder === undefined || folder === null || folder === '') return null;
    const all = (await padApi.overview()).folders;
    const n = Number(folder);
    const hit = Number.isInteger(n) && n > 0
      ? all.find((f) => f.id === n)
      : all.find((f) => f.name.toLowerCase() === String(folder).trim().toLowerCase());
    if (!hit) throw new Error(`There is no folder “${String(folder)}”. Folders: ${all.map((f) => `${f.name} (id ${f.id})`).join(', ') || 'none yet'}.`);
    return hit.id;
  };
  const summary = (n: { id: number; title: string; folderId: number | null; pinned: boolean; updatedAt: number; deletedAt: number | null; snippet: string }, names: Map<number, string>) => ({
    id: n.id,
    title: n.title || '(empty)',
    folder: n.folderId === null ? 'Notes' : names.get(n.folderId) ?? 'Notes',
    pinned: n.pinned,
    updated: new Date(n.updatedAt).toISOString(),
    deleted: n.deletedAt !== null || undefined,
    preview: n.snippet,
  });
  const names = async () => new Map((await padApi.overview()).folders.map((f) => [f.id, f.name]));
  const toHtml = (markdown: string) => markdownToHtml(markdown);

  return [
    {
      name: 'notes_list_folders',
      description: "List the folders in the student's Notes app (their own notes, separate from study notebooks), with how many notes each holds. \"Notes\" is the default place for notes in no folder.",
      inputs: {},
      outputType: 'object',
      scopes: ['pad'],
      label: 'Looking through your Notes',
      state: 'retrieving',
      async run() {
        const o = await padApi.overview();
        return { result: { folders: o.folders, inNoFolder: o.unfiled, total: o.all, recentlyDeleted: o.deleted }, detail: `${o.folders.length} folder${o.folders.length === 1 ? '' : 's'}` };
      },
    },
    {
      name: 'notes_list',
      description: 'List notes in the Notes app: all of them, one folder\'s, or those matching a search (every word must appear). Returns id, title, folder and a preview; read one with notes_read.',
      inputs: {
        folder: { type: 'string', description: 'A folder name or id; leave out for every note. Use "Notes" for notes in no folder, "deleted" for Recently Deleted.', nullable: true },
        query: { type: 'string', description: 'Words to search for.', nullable: true },
      },
      outputType: 'array',
      scopes: ['pad', 'search'],
      label: 'Listing your notes',
      state: 'retrieving',
      async run(args) {
        const q = String(args.query ?? '').trim();
        const f = String(args.folder ?? '').trim();
        const list = q ? await padApi.search(q)
          : !f ? await padApi.notes('all')
            : f.toLowerCase() === 'deleted' || f.toLowerCase() === 'recently deleted' ? await padApi.notes('deleted')
              : f.toLowerCase() === 'notes' ? await padApi.notes('unfiled')
                : await padApi.notes('folder', await folderId(f));
        const m = await names();
        return { result: list.slice(0, 200).map((n) => summary(n, m)), detail: `${list.length} note${list.length === 1 ? '' : 's'}` };
      },
    },
    {
      name: 'notes_read',
      description: 'Read one note from the Notes app in full, as Markdown (checklists as - [ ] / - [x], maths as $…$).',
      inputs: { noteId: { type: 'integer', description: 'The note id, from notes_list.' } },
      outputType: 'object',
      scopes: ['pad'],
      label: 'Reading a note',
      state: 'retrieving',
      async run(args) {
        const n = await padApi.note(Number(args.noteId));
        const m = await names();
        return { result: { ...summary(n, m), markdown: clip(htmlToMarkdown(n.html), 60_000) }, detail: n.title || 'note' };
      },
    },
    {
      name: 'notes_create',
      description: 'Write a new note in the Notes app. The first line is its title (make it a short heading). Markdown: headings, lists, checklists (- [ ] item), bold, links, tables, maths in $…$. Opens it for the student unless open is false.',
      inputs: {
        content: { type: 'string', description: 'The note, in Markdown. Start with its title on the first line.' },
        folder: { type: 'string', description: 'Folder name or id; leave out for "Notes". Create the folder first with notes_create_folder if it does not exist.', nullable: true },
        pinned: { type: 'boolean', description: 'Pin it to the top.', nullable: true },
        open: { type: 'boolean', description: 'Show it to the student (default true).', nullable: true },
      },
      outputType: 'object',
      scopes: ['pad'],
      mutating: true,
      label: 'Writing a note',
      async run(args) {
        const html = toHtml(String(args.content ?? ''));
        const n = await padApi.create(await folderId(args.folder), html, htmlToText(html), BY);
        if (args.pinned === true) await padApi.pin(n.id, true, BY);
        if (args.open !== false) env.open({ kind: 'notes', id: n.id });
        return { result: { id: n.id, title: n.title }, label: `Wrote “${n.title || 'a note'}”`, detail: n.title };
      },
    },
    {
      name: 'notes_edit',
      description: 'Change a note in the Notes app. mode "replace" rewrites the whole note with content; "append" adds content at the end; "prepend" adds it at the top (under nothing - it becomes the new first line/title); "find_replace" replaces the first occurrence of find (plain text within one paragraph) with content. Read the note first when editing part of it.',
      inputs: {
        noteId: { type: 'integer', description: 'The note id.' },
        mode: { type: 'string', description: 'How to change it.', enum: ['replace', 'append', 'prepend', 'find_replace'] },
        content: { type: 'string', description: 'The new Markdown (or, for find_replace, the replacement text).' },
        find: { type: 'string', description: 'find_replace only: the exact text to replace.', nullable: true },
      },
      outputType: 'object',
      scopes: ['pad'],
      mutating: true,
      label: 'Editing a note',
      async run(args) {
        const id = Number(args.noteId);
        const n = await padApi.note(id);
        const mode = String(args.mode ?? 'replace');
        const content = String(args.content ?? '');
        let html: string;
        if (mode === 'append') html = n.html + toHtml(content);
        else if (mode === 'prepend') html = toHtml(content) + n.html;
        else if (mode === 'find_replace') {
          const find = String(args.find ?? '');
          if (!find) throw new Error('find_replace needs the text to find.');
          const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          if (!n.html.includes(esc(find))) throw new Error(`“${find}” is not in that note as written. Read it with notes_read and use the exact text, or replace the whole note.`);
          html = n.html.replace(esc(find), esc(content));
        } else html = toHtml(content);
        await padApi.save(id, html, htmlToText(html), BY);
        return { result: { id, ok: true }, label: `Edited “${n.title || 'a note'}”`, detail: mode };
      },
    },
    {
      name: 'notes_move',
      description: 'Move a note to another folder in the Notes app (or out of Recently Deleted).',
      inputs: {
        noteId: { type: 'integer', description: 'The note id.' },
        folder: { type: 'string', description: 'Folder name or id; "Notes" for no folder.', nullable: true },
      },
      outputType: 'object',
      scopes: ['pad'],
      mutating: true,
      label: 'Moving a note',
      async run(args) {
        const f = String(args.folder ?? '').trim();
        const to = !f || f.toLowerCase() === 'notes' ? null : await folderId(f);
        await padApi.move(Number(args.noteId), to, BY);
        return { result: { ok: true }, detail: f || 'Notes' };
      },
    },
    {
      name: 'notes_pin',
      description: 'Pin a note to the top of its list in the Notes app, or unpin it.',
      inputs: {
        noteId: { type: 'integer', description: 'The note id.' },
        pinned: { type: 'boolean', description: 'true to pin, false to unpin.' },
      },
      outputType: 'object',
      scopes: ['pad'],
      mutating: true,
      label: 'Pinning a note',
      async run(args) {
        await padApi.pin(Number(args.noteId), args.pinned !== false, BY);
        return { result: { ok: true } };
      },
    },
    {
      name: 'notes_delete',
      description: 'Delete a note from the Notes app. It goes to Recently Deleted, where the student (or notes_restore) can recover it.',
      inputs: { noteId: { type: 'integer', description: 'The note id.' } },
      outputType: 'object',
      scopes: ['pad'],
      mutating: true,
      label: 'Deleting a note',
      async run(args) {
        await padApi.remove(Number(args.noteId), false, BY);
        return { result: { ok: true, recoverable: true } };
      },
    },
    {
      name: 'notes_restore',
      description: 'Recover a note from Recently Deleted in the Notes app.',
      inputs: { noteId: { type: 'integer', description: 'The note id.' } },
      outputType: 'object',
      scopes: ['pad'],
      mutating: true,
      label: 'Recovering a note',
      async run(args) {
        await padApi.restore(Number(args.noteId), BY);
        return { result: { ok: true } };
      },
    },
    {
      name: 'notes_create_folder',
      description: 'Make a new folder in the Notes app.',
      inputs: { name: { type: 'string', description: 'The folder name.' } },
      outputType: 'object',
      scopes: ['pad'],
      mutating: true,
      label: 'Making a folder',
      async run(args) {
        const f = await padApi.createFolder(String(args.name ?? ''), BY);
        return { result: f, label: `Made the folder “${f.name}”` };
      },
    },
    {
      name: 'notes_rename_folder',
      description: 'Rename a folder in the Notes app.',
      inputs: {
        folder: { type: 'string', description: 'The folder name or id.' },
        name: { type: 'string', description: 'Its new name.' },
      },
      outputType: 'object',
      scopes: ['pad'],
      mutating: true,
      label: 'Renaming a folder',
      async run(args) {
        const id = await folderId(args.folder);
        if (id === null) throw new Error('Name the folder to rename.');
        await padApi.renameFolder(id, String(args.name ?? ''), BY);
        return { result: { ok: true }, detail: String(args.name ?? '') };
      },
    },
    {
      name: 'notes_delete_folder',
      description: 'Delete a folder in the Notes app. Its notes go to Recently Deleted (recoverable), not nowhere.',
      inputs: { folder: { type: 'string', description: 'The folder name or id.' } },
      outputType: 'object',
      scopes: ['pad'],
      mutating: true,
      label: 'Deleting a folder',
      async run(args) {
        const id = await folderId(args.folder);
        if (id === null) throw new Error('Name the folder to delete.');
        await padApi.deleteFolder(id, BY);
        return { result: { ok: true } };
      },
    },
    {
      name: 'notes_open',
      description: 'Show a note to the student in the Notes app.',
      inputs: { noteId: { type: 'integer', description: 'The note id.' } },
      outputType: 'object',
      scopes: ['pad', 'ui'],
      label: 'Opening a note',
      async run(args) {
        env.open({ kind: 'notes', id: Number(args.noteId) });
        return { result: { ok: true } };
      },
    },
  ];
}

export function registry(env: ToolEnv): SalemTool[] {
  const app = appTools({ tree: env.tree, refresh: env.refresh, open: env.open });
  const wrapped: SalemTool[] = (APP_TOOL_DEFS as FunctionDef[]).map((def) => {
    const { name, description, inputs } = convert(def);
    const meta = META[name] ?? { scopes: ['study'], label: `Running ${name.replace(/_/g, ' ')}` };
    return {
      name,
      description,
      inputs,
      outputType: 'object',
      scopes: meta.scopes,
      mutating: meta.mutating,
      label: meta.label,
      timeout: name === 'write_notes' || name === 'make_quiz' || name === 'make_flashcards' ? 600 : 90,
      async run(args): Promise<ToolOutcome> {
        const r = await app.run(name, args);
        if (!r.ok) throw new Error(r.detail || r.label);
        return { result: r.result, label: r.label, detail: r.detail };
      },
    };
  });
  return [...wrapped, ...sourceTools(env), ...noteTools(env), ...padTools(env), ...madeTools(env), ...materialTools(env), ...NATIVE];
}

export async function dispatch(tools: SalemTool[], name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`There is no tool called ${name}.`);
  if (!tool.run) throw new Error(`${name} is served by the app itself and should not have been forwarded.`);
  const missing = Object.entries(tool.inputs)
    .filter(([key, spec]) => !spec.nullable && (args[key] === undefined || args[key] === null))
    .map(([key]) => key);
  if (missing.length) throw new Error(`${name} needs ${missing.join(', ')}.`);
  const outcome = await tool.run(args);
  return { result: outcome.result, label: outcome.label, detail: outcome.detail };
}

export const answerTool = (call: number, ok: boolean, data?: unknown, error?: string) =>
  invoke<void>('salem_tool_result', { call, ok, data: data ?? null, error: error ?? null });

export type { NotebookSummary };
