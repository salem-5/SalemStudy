// Browser-only stand-in for the Study commands (`npm run dev` without Tauri).
// Mirrors the Rust behaviour closely enough to exercise the UI: localStorage
// for data, word overlap for search.
import {
  studyApi, type AttachmentInfo, type Attempt, type AttemptAnswer, type Card, type CardResult, type ChatMessage, type ChatThread, type Deck,
  type DeckRun, type MessageMeta, type Note, type NewCard, type NotebookSummary, type Quiz, type QuizQuestion, type Review, type Source, type SourceHit,
  type ExtractionReport, type SourceUnit, type SubjectNode, type StudyEvent, type EventInput,
} from './api';

type Db = {
  next: number;
  subjects: SubjectNode[];
  threads: ChatThread[];
  messages: (ChatMessage & { conversationId: number })[];
  attachments: (AttachmentInfo & { data: string; conversationId: number | null })[];
  decks: { id: number; notebookId: number; title: string; createdAt: number; updatedAt: number }[];
  cards: Omit<Card, 'reviews' | 'misses' | 'lastCorrect'>[];
  reviews: (Review & { notebookId: number })[];
  runs: (DeckRun & { notebookId: number })[];
  quizzes: Quiz[];
  attempts: (Attempt & { notebookId: number })[];
  sources: (Source & { data: string | null })[];
  notes: Note[];
  events?: StudyEvent[];
  memory?: { id: number; text: string; source: 'chat' | 'user'; createdAt: number; updatedAt: number }[];
  usage?: { at: number; model: string; feature: string; tokens: number; cost: number }[];
  images?: { id: number; sourceId: number; unitOrd: number; caption: string; data: string }[];
  units: (SourceUnit & { sourceId: number })[];
  focus?: { startedAt: number; finishedAt: number; minutes: number; tasksDone: number }[];
};

const KEY = 'wa.study.mock.v4';

function seed(): Db {
  let next = 1;
  const nb = (subjectId: number, name: string): NotebookSummary =>
    ({ id: next++, subjectId, name, description: '', sourceCount: 0, cardCount: 0, quizCount: 0, deckCount: 0, noteCount: 0, overview: '', overviewAt: 0, updatedAt: Date.now() });
  const subj = (name: string, names: string[]): SubjectNode => {
    const id = next++;
    return { id, name, context: '', icon: '', color: '', syllabusName: '', syllabusSummary: '', syllabusAt: 0, notebooks: names.map((n) => nb(id, n)) };
  };
  const subjects = [
    subj('Calculus II', ['Midterm Review', 'Integration', 'Series']),
    subj('Physics I', ['Kinematics', "Newton's Laws", 'Energy']),
    subj('Linear Algebra', ['Vectors', 'Matrices']),
  ];
  // One quiz covering every question type, so the player, the navigator, the
  // hints and Ask AI can all be exercised in the browser preview.
  const demoQuiz: Quiz = {
    id: next++,
    notebookId: subjects[0].notebooks[0].id,
    title: 'Convergence tests (demo)',
    createdAt: Date.now(),
    questions: [
      {
        type: 'mcq', topic: 'Ratio test', difficulty: 'easy',
        prompt: 'The ratio test gives $L = 1$ for a series. What can you conclude?',
        choices: ['Nothing — the test is inconclusive', 'It converges', 'It diverges', 'It converges conditionally'],
        answer: 0,
        hint: 'Think about $\\sum 1/n$ and $\\sum 1/n^2$ — what does the test give for each?',
        explanation: 'Both $\\sum 1/n$ (divergent) and $\\sum 1/n^2$ (convergent) give $L = 1$, so the test cannot separate them.',
        verified: true,
      },
      {
        type: 'multi', topic: 'Comparison', difficulty: 'medium',
        prompt: 'Which of these series **converge**?',
        choices: ['$\\sum 1/n^2$', '$\\sum 1/n$', '$\\sum (1/2)^n$', '$\\sum n$'],
        answers: [0, 2], answer: '0,2',
        hint: 'One is a $p$-series and one is geometric. Check $p$ and check $|r|$.',
        explanation: '$\\sum 1/n^2$ is a $p$-series with $p = 2 > 1$, and $\\sum (1/2)^n$ is geometric with $|r| < 1$.',
      },
      {
        type: 'tf', topic: 'p-series', difficulty: 'easy',
        prompt: 'The harmonic series $\\sum 1/n$ converges.',
        answer: 'false',
        hint: 'Compare the partial sums with $\\ln n$.',
        explanation: 'It is the $p$-series with $p = 1$, which diverges — the partial sums grow like $\\ln n$.',
      },
      {
        type: 'numeric', topic: 'Geometric series', difficulty: 'medium',
        prompt: 'Evaluate $\\sum_{n=0}^{\\infty} (1/4)^n$.',
        answer: 1.3333333, tolerance: 0.001,
        hint: 'The sum of a geometric series is $1/(1-r)$ when $|r| < 1$.',
        explanation: '$\\frac{1}{1 - 1/4} = \\frac{4}{3} \\approx 1.333$.',
        verified: true,
      },
      {
        type: 'blank', topic: 'Vocabulary', difficulty: 'easy',
        prompt: 'A series that converges but whose absolute values do not is called ______ convergent.',
        answer: 'conditionally', accept: ['conditional'],
        hint: 'The opposite of absolutely.',
        explanation: 'Conditional convergence: $\\sum a_n$ converges while $\\sum |a_n|$ does not, as with the alternating harmonic series.',
      },
      {
        type: 'short', topic: 'Integral test', difficulty: 'hard',
        prompt: 'In a sentence, when may the integral test be used?',
        answer: 'When the terms come from a function that is positive, continuous and decreasing on the interval.',
        hint: 'Three conditions on the function the terms come from.',
        explanation: 'The function must be positive, continuous and eventually decreasing; then the series and the improper integral converge or diverge together.',
      },
    ],
  };

  return { next, subjects, threads: [], messages: [], attachments: [], decks: [], cards: [], reviews: [], runs: [], quizzes: [demoQuiz], attempts: [], sources: [], units: [], notes: [] };
}

/** As in Rust: a notebook's course wins over the one given. */
const courseOf = (db: { subjects: SubjectNode[] }, e: EventInput) =>
  (e.notebookId !== null ? db.subjects.find((s) => s.notebooks.some((n) => n.id === e.notebookId))?.id : undefined) ?? e.subjectId ?? null;

export function installStudyMock() {
  const load = (): Db => {
    try { return { ...seed(), ...(JSON.parse(localStorage.getItem(KEY) || '') as Db) }; } catch { return seed(); }
  };
  const save = (db: Db) => {
    // Source files can be big; keep them out of localStorage.
    try { localStorage.setItem(KEY, JSON.stringify({ ...db, sources: db.sources.map((s) => ({ ...s, data: s.data && s.data.length < 200_000 ? s.data : null })) })); } catch { /* quota */ }
  };
  const mutate = <T,>(fn: (db: Db) => T): Promise<T> => {
    try {
      const db = load();
      const out = fn(db);
      save(db);
      return Promise.resolve(structuredClone(out));
    } catch (e) {
      return Promise.reject(e);
    }
  };
  const clean = (n: string) => {
    const t = n.trim();
    if (!t) throw 'Name cannot be empty.';
    return t;
  };
  const findNb = (db: Db, id: number) => db.subjects.flatMap((s) => s.notebooks).find((n) => n.id === id);
  const withCounts = (db: Db): SubjectNode[] => db.subjects.map((s) => ({
    ...s,
    notebooks: s.notebooks.map((n) => ({
      ...n,
      cardCount: db.cards.filter((c) => c.notebookId === n.id).length,
      deckCount: db.decks.filter((d) => d.notebookId === n.id).length,
      quizCount: db.quizzes.filter((q) => q.notebookId === n.id).length,
      noteCount: db.notes.filter((x) => x.notebookId === n.id).length,
      sourceCount: db.sources.filter((x) => x.notebookId === n.id).length,
    })),
  }));
  const threadOut = (db: Db, t: ChatThread): ChatThread => ({ ...t, messageCount: db.messages.filter((m) => m.conversationId === t.id).length });
  const deckOut = (db: Db, d: Db['decks'][number]): Deck => {
    const runs = db.runs.filter((r) => r.deckId === d.id);
    const pct = runs.map((r) => (r.total ? r.correct / r.total : 0));
    return { ...d, cardCount: db.cards.filter((c) => c.deckId === d.id).length, runs: runs.length, best: pct.length ? Math.max(...pct) : null, last: pct.at(-1) ?? null };
  };
  const cardOut = (db: Db, c: Db['cards'][number]): Card => {
    const rs = db.reviews.filter((r) => r.cardId === c.id);
    return { ...c, reviews: rs.length, misses: rs.filter((r) => !r.correct).length, lastCorrect: rs.at(-1)?.correct ?? null };
  };
  const words = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
  const hitsFor = (db: Db, ids: number[]): SourceHit[] => db.units
    .filter((u) => ids.includes(u.sourceId))
    .map((u, i) => {
      const s = db.sources.find((x) => x.id === u.sourceId)!;
      return { chunkId: i + 1, sourceId: s.id, sourceTitle: s.title, kind: s.kind, unitFrom: u.ord, unitTo: u.ord, label: u.label, text: u.text, score: 0 };
    });

  Object.assign(studyApi, {
    tree: () => mutate(withCounts),
    createSubject: (name: string) => mutate((db) => {
      const id = db.next++;
      db.subjects.push({ id, name: clean(name), context: '', icon: '', color: '', syllabusName: '', syllabusSummary: '', syllabusAt: 0, notebooks: [] });
      return id;
    }),
    setSyllabus: (subjectId: number, x: { file: number | null; name: string; text: string; summary: string }) => mutate((db) => {
      const s = db.subjects.find((v) => v.id === subjectId);
      if (!s) throw 'Subject not found.';
      Object.assign(s, { syllabusName: x.name, syllabusSummary: x.summary, syllabusAt: x.name ? Date.now() : 0, syllabusText: x.text });
    }),
    clearSyllabus: (subjectId: number) => mutate((db) => {
      const s = db.subjects.find((v) => v.id === subjectId);
      if (s) Object.assign(s, { syllabusName: '', syllabusSummary: '', syllabusAt: 0, syllabusText: '' });
    }),
    syllabusText: (subjectId: number) => mutate((db) => (db.subjects.find((v) => v.id === subjectId) as { syllabusText?: string } | undefined)?.syllabusText ?? ''),
    updateSubject: (id: number, p: { name?: string; context?: string; icon?: string; color?: string }) => mutate((db) => {
      const s = db.subjects.find((x) => x.id === id);
      if (!s) throw 'Subject not found.';
      if (p.name != null) s.name = clean(p.name);
      if (p.context != null) s.context = p.context;
      if (p.icon != null) s.icon = p.icon;
      if (p.color != null) s.color = p.color;
    }),
    setOverview: (id: number, overview: string) => mutate((db) => { const n = findNb(db, id); if (n) Object.assign(n, { overview, overviewAt: Date.now() }); }),
    activity: (since: number) => mutate((db) => [
      ...db.reviews.map((r) => r.reviewedAt), ...db.attempts.map((a) => a.finishedAt),
      ...db.messages.filter((m) => m.role === 'user').map((m) => m.createdAt), ...db.notes.map((n) => n.createdAt), ...db.sources.map((x) => x.createdAt),
      ...(db.focus ?? []).map((f) => f.finishedAt),
    ].filter((t) => t >= since)),
    activityDetail: (from: number, to: number) => mutate((db) => {
      const where = (notebookId: number | null) => {
        const sub = db.subjects.find((x) => x.notebooks.some((n) => n.id === notebookId));
        const nb = sub?.notebooks.find((n) => n.id === notebookId);
        return { notebookId, notebook: nb?.name ?? null, subject: sub?.name ?? null };
      };
      const rows = [
        ...db.reviews.map((r) => ({ at: r.reviewedAt, kind: 'card' as const, ...where(r.notebookId) })),
        ...db.attempts.map((a) => ({ at: a.finishedAt, kind: 'quiz' as const, ...where(a.notebookId) })),
        ...db.messages.filter((m) => m.role === 'user').map((m) => ({
          at: m.createdAt, kind: 'chat' as const,
          ...where(db.threads.find((t) => t.id === m.conversationId)?.notebookId ?? null),
        })),
        ...db.notes.map((n) => ({ at: n.createdAt, kind: 'note' as const, ...where(n.notebookId) })),
        ...db.sources.map((x) => ({ at: x.createdAt, kind: 'source' as const, ...where(x.notebookId) })),
        ...(db.focus ?? []).map((f) => ({ at: f.finishedAt, kind: 'focus' as const, notebookId: null, notebook: null, subject: null })),
      ];
      return rows.filter((r) => r.at >= from && r.at < to).sort((a, b) => a.at - b.at);
    }),
    addFocusSession: (phase: string, startedAt: number, finishedAt: number, tasksDone: number) => mutate((db) => {
      const minutes = Math.floor(Math.max(0, finishedAt - startedAt) / 60_000);
      if (phase !== 'focus' || minutes < 1) return;
      db.focus = [...(db.focus ?? []), { startedAt, finishedAt, minutes, tasksDone }];
    }),
    focusMinutes: (since: number) => mutate((db) =>
      (db.focus ?? []).filter((f) => f.finishedAt >= since).map((f) => [f.finishedAt, f.minutes] as [number, number])),
    usage: () => mutate((db) => {
      const rows = db.usage ?? [];
      const sum = (rs: typeof rows, key = '') => ({ key, calls: rs.length, tokens: rs.reduce((a, r) => a + r.tokens, 0), cost: rs.reduce((a, r) => a + r.cost, 0) });
      const by = (f: (r: (typeof rows)[number]) => string) => [...new Set(rows.map(f))].map((k) => sum(rows.filter((r) => f(r) === k), k)).sort((a, b) => b.cost - a.cost);
      const from30 = Date.now() - 30 * 864e5;
      return { total: sum(rows), last30: sum(rows.filter((r) => r.at >= from30)), byFeature: by((r) => r.feature), byModel: by((r) => r.model), byDay: by((r) => new Date(r.at).toISOString().slice(0, 10)).sort((a, b) => a.key.localeCompare(b.key)), since: rows[0]?.at ?? null };
    }),
    memories: () => mutate((db) => {
      const items = db.memory ?? [];
      return { items, used: items.reduce((a, m) => a + m.text.length, 0), capacity: 12000 };
    }),
    addMemory: (text: string, source: 'chat' | 'user' = 'chat') => mutate((db) => {
      const t = text.trim().replace(/\s+/g, ' ').slice(0, 400);
      if (!t) throw 'A memory needs some text.';
      const same = (db.memory ?? []).find((m) => m.text.toLowerCase() === t.toLowerCase());
      if (same) return same;
      const m = { id: db.next++, text: t, source, createdAt: Date.now(), updatedAt: Date.now() };
      db.memory = [...(db.memory ?? []), m];
      return m;
    }),
    updateMemory: (id: number, text: string) => mutate((db) => { const m = (db.memory ?? []).find((x) => x.id === id); if (!m) throw 'Memory not found.'; m.text = text.trim(); m.updatedAt = Date.now(); }),
    deleteMemory: (id: number) => mutate((db) => { db.memory = (db.memory ?? []).filter((m) => m.id !== id); }),
    clearMemories: () => mutate((db) => { const n = (db.memory ?? []).length; db.memory = []; return n; }),
    resetUsage: () => mutate((db) => { db.usage = []; }),
    events: (from: number, to: number) => mutate((db) => (db.events ?? []).filter((e) => e.startAt < to && (e.endAt ?? e.startAt) >= from).sort((a, b) => a.startAt - b.startAt)),
    addEvent: (event: EventInput) => mutate((db) => { const e = { ...event, subjectId: courseOf(db, event), id: db.next++ }; db.events = [...(db.events ?? []), e]; return e; }),
    updateEvent: (id: number, event: EventInput) => mutate((db) => { const e = (db.events ?? []).find((x) => x.id === id); if (!e) throw 'Event not found.'; Object.assign(e, event, { subjectId: courseOf(db, event) }); return e; }),
    deleteEvent: (id: number) => mutate((db) => { db.events = (db.events ?? []).filter((e) => e.id !== id); }),
    searchEverything: (query: string) => mutate((db) => {
      const q = query.trim().toLowerCase();
      if (q.length < 2) return [];
      const snip = (t: string) => { const i = t.toLowerCase().indexOf(q); return t.slice(Math.max(0, i - 50), i + 130).replace(/\n/g, ' '); };
      return [
        ...db.units.filter((u) => u.text.toLowerCase().includes(q)).slice(0, 12).map((u) => { const src = db.sources.find((x) => x.id === u.sourceId)!; return { kind: 'source' as const, id: src.id, notebookId: src.notebookId, title: src.title, detail: u.label, snippet: snip(u.text), target: u.ord }; }),
        ...db.notes.filter((n) => (n.title + n.content).toLowerCase().includes(q)).map((n) => ({ kind: 'note' as const, id: n.id, notebookId: n.notebookId, title: n.title, detail: '', snippet: snip(n.content), target: null })),
        ...db.cards.filter((c) => (c.front + c.back).toLowerCase().includes(q)).map((c) => ({ kind: 'card' as const, id: c.id, notebookId: c.notebookId, title: c.front, detail: db.decks.find((d) => d.id === c.deckId)?.title ?? '', snippet: c.back, target: c.deckId })),
        ...db.threads.filter((t) => db.messages.some((m) => m.conversationId === t.id && m.content.toLowerCase().includes(q))).map((t) => ({ kind: 'chat' as const, id: t.id, notebookId: t.notebookId, title: t.title || 'Chat', detail: '', snippet: snip(db.messages.find((m) => m.conversationId === t.id && m.content.toLowerCase().includes(q))!.content), target: null })),
      ];
    }),
    addSourceImage: (sourceId: number, unitOrd: number, mime: string, data: string, caption: string) => mutate((db) => {
      const id = db.next++;
      db.images = [...(db.images ?? []), { id, sourceId, unitOrd, caption, data: data.startsWith('data:') ? data : `data:${mime};base64,${data}` }];
      return id;
    }),
    clearSourceImages: (sourceId: number) => mutate((db) => { db.images = (db.images ?? []).filter((i) => i.sourceId !== sourceId); }),
    sourceImages: (sourceId: number) => mutate((db) => (db.images ?? []).filter((i) => i.sourceId === sourceId).map(({ id, unitOrd, caption }) => ({ id, unitOrd, caption }))),
    sourceImageData: (id: number) => mutate((db) => { const i = (db.images ?? []).find((x) => x.id === id); if (!i) throw 'Image not found.'; return i.data; }),
    deleteSubject: (id: number) => mutate((db) => {
      const gone = db.subjects.find((s) => s.id === id);
      const notebooks = new Set((gone?.notebooks ?? []).map((n) => n.id));
      db.subjects = db.subjects.filter((s) => s.id !== id);
      // The calendar goes with the course, as it does in the real database.
      db.events = (db.events ?? []).filter((e) => e.subjectId !== id && !notebooks.has(e.notebookId as number));
    }),
    createNotebook: (subjectId: number, name: string, description?: string) => mutate((db) => {
      const s = db.subjects.find((x) => x.id === subjectId);
      if (!s) throw 'Subject not found.';
      const id = db.next++;
      s.notebooks.push({ id, subjectId, name: clean(name), description: description?.trim() ?? '', sourceCount: 0, cardCount: 0, quizCount: 0, deckCount: 0, noteCount: 0, overview: '', overviewAt: 0, updatedAt: Date.now() });
      return id;
    }),
    updateNotebook: (id: number, p: { name?: string; description?: string }) => mutate((db) => {
      const n = findNb(db, id);
      if (!n) throw 'Notebook not found.';
      if (p.name != null) n.name = clean(p.name);
      if (p.description != null) n.description = p.description.trim();
    }),
    deleteNotebook: (id: number) => mutate((db) => { for (const s of db.subjects) s.notebooks = s.notebooks.filter((n) => n.id !== id); }),

    chatList: (notebookId: number | null) => mutate((db) =>
      db.threads.filter((t) => t.notebookId === notebookId).sort((a, b) => b.updatedAt - a.updatedAt).map((t) => threadOut(db, t))),
    chatCreate: (notebookId: number | null, title = '') => mutate((db) => {
      const t: ChatThread = { id: db.next++, notebookId, title, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 };
      db.threads.push(t);
      return t;
    }),
    chatRename: (id: number, title: string) => mutate((db) => { const t = db.threads.find((x) => x.id === id); if (t) t.title = title; }),
    chatDelete: (id: number) => mutate((db) => { db.threads = db.threads.filter((t) => t.id !== id); db.messages = db.messages.filter((m) => m.conversationId !== id); }),
    chatClear: (id: number) => mutate((db) => { db.messages = db.messages.filter((m) => m.conversationId !== id); }),
    chatTruncate: (conversationId: number, fromId: number) => mutate((db) => {
      const before = db.messages.length;
      db.messages = db.messages.filter((m) => m.conversationId !== conversationId || m.id < fromId);
      return before - db.messages.length;
    }),
    chatDeleteAll: (notebookId: number | null) => mutate((db) => {
      const gone = new Set(db.threads.filter((t) => t.notebookId === notebookId).map((t) => t.id));
      db.threads = db.threads.filter((t) => !gone.has(t.id));
      db.messages = db.messages.filter((m) => !gone.has(m.conversationId));
      return gone.size;
    }),
    notes: (notebookId: number) => mutate((db) => db.notes.filter((n) => n.notebookId === notebookId).sort((a, b) => b.updatedAt - a.updatedAt)),
    note: (id: number) => mutate((db) => { const n = db.notes.find((x) => x.id === id); if (!n) throw 'Note not found.'; return n; }),
    createNote: (notebookId: number, title: string, content: string, instructions = '') => mutate((db) => {
      const n: Note = { id: db.next++, notebookId, title: title.trim() || 'Untitled note', content, instructions, createdAt: Date.now(), updatedAt: Date.now() };
      db.notes.push(n);
      return n;
    }),
    updateNote: (id: number, p: { title?: string; content?: string; instructions?: string }) => mutate((db) => {
      const n = db.notes.find((x) => x.id === id);
      if (!n) throw 'Note not found.';
      if (p.title != null) n.title = clean(p.title);
      if (p.content != null) n.content = p.content;
      if (p.instructions != null) n.instructions = p.instructions;
      n.updatedAt = Date.now();
      return n;
    }),
    deleteNote: (id: number) => mutate((db) => { db.notes = db.notes.filter((n) => n.id !== id); }),
    chatMessages: (id: number) => mutate((db) => db.messages.filter((m) => m.conversationId === id)),
    chatAddMessage: (conversationId: number, role: ChatMessage['role'], content: string, meta: MessageMeta = null) => mutate((db) => {
      const m = { id: db.next++, conversationId, role, content, meta, createdAt: Date.now() };
      db.messages.push(m);
      const t = db.threads.find((x) => x.id === conversationId);
      if (t) t.updatedAt = m.createdAt;
      return m;
    }),
    attachmentAdd: (a: { conversationId?: number | null; kind: string; name: string; mime: string; data: string; text?: string | null }) => mutate((db) => {
      const data = a.data.startsWith('data:') ? a.data : `data:${a.mime};base64,${a.data}`;
      const row = { id: db.next++, kind: a.kind, name: a.name, mime: a.mime, size: Math.round(a.data.length * 0.75), text: a.text ?? null, data, conversationId: a.conversationId ?? null };
      db.attachments.push(row);
      const { data: _d, conversationId: _c, ...info } = row;
      return info;
    }),
    attachmentData: (id: number) => mutate((db) => { const a = db.attachments.find((x) => x.id === id); if (!a) throw 'Attachment not found.'; return a.data; }),
    attachmentSetText: (id: number, text: string) => mutate((db) => { const a = db.attachments.find((x) => x.id === id); if (a) a.text = text; }),
    attachmentsInfo: (ids: number[]) => mutate((db) => ids.flatMap((id) => {
      const a = db.attachments.find((x) => x.id === id);
      if (!a) return [];
      const { data: _d, conversationId: _c, ...info } = a;
      return [info];
    })),

    decks: (notebookId: number) => mutate((db) => db.decks.filter((d) => d.notebookId === notebookId).sort((a, b) => b.updatedAt - a.updatedAt).map((d) => deckOut(db, d))),
    createDeck: (notebookId: number, title: string, cards: NewCard[]) => mutate((db) => {
      const id = db.next++;
      db.decks.push({ id, notebookId, title: title.trim() || 'Untitled deck', createdAt: Date.now(), updatedAt: Date.now() });
      for (const c of cards) db.cards.push({ id: db.next++, deckId: id, notebookId, front: c.front, back: c.back, topic: c.topic ?? '', sourceRefs: c.sourceRefs ?? null, createdAt: Date.now() });
      return id;
    }),
    renameDeck: (id: number, title: string) => mutate((db) => { const d = db.decks.find((x) => x.id === id); if (!d) throw 'Deck not found.'; d.title = clean(title); }),
    deleteDeck: (id: number) => mutate((db) => { db.decks = db.decks.filter((d) => d.id !== id); db.cards = db.cards.filter((c) => c.deckId !== id); }),
    deckCards: (deckId: number) => mutate((db) => db.cards.filter((c) => c.deckId === deckId).map((c) => cardOut(db, c))),
    addCards: (deckId: number, cards: NewCard[]) => mutate((db) => {
      const d = db.decks.find((x) => x.id === deckId);
      if (!d) throw 'Deck not found.';
      d.updatedAt = Date.now();
      return cards.map((c) => { const id = db.next++; db.cards.push({ id, deckId, notebookId: d.notebookId, front: c.front, back: c.back, topic: c.topic ?? '', sourceRefs: null, createdAt: Date.now() }); return id; });
    }),
    updateCard: (id: number, front: string, back: string, topic: string) => mutate((db) => { const c = db.cards.find((x) => x.id === id); if (c) Object.assign(c, { front, back, topic }); }),
    deleteCard: (id: number) => mutate((db) => { db.cards = db.cards.filter((c) => c.id !== id); }),
    addDeckRun: (deckId: number, startedAt: number, results: CardResult[]) => mutate((db) => {
      const d = db.decks.find((x) => x.id === deckId);
      if (!d) throw 'Deck not found.';
      const now = Date.now();
      d.updatedAt = now;
      for (const r of results) {
        const c = db.cards.find((x) => x.id === r.cardId);
        db.reviews.push({ cardId: r.cardId, correct: r.correct, elapsedMs: r.elapsedMs, reviewedAt: now, topic: c?.topic ?? '', notebookId: d.notebookId });
      }
      const id = db.next++;
      db.runs.push({ id, deckId, deckTitle: d.title, startedAt, finishedAt: now, correct: results.filter((r) => r.correct).length, total: results.length, notebookId: d.notebookId });
      return id;
    }),
    deckRuns: (notebookId: number, since: number) => mutate((db) => db.runs.filter((r) => r.notebookId === notebookId && r.finishedAt >= since).map(({ notebookId: _n, ...r }) => ({ ...r, deckTitle: db.decks.find((d) => d.id === r.deckId)?.title ?? r.deckTitle }))),
    reviews: (notebookId: number, since: number) => mutate((db) => db.reviews.filter((r) => r.notebookId === notebookId && r.reviewedAt >= since).map(({ notebookId: _n, ...r }) => r)),

    quizzes: (notebookId: number) => mutate((db) => db.quizzes.filter((q) => q.notebookId === notebookId).map((q) => {
      const at = db.attempts.filter((a) => a.quizId === q.id);
      const pct = at.map((a) => (a.total ? a.score / a.total : 0));
      return { id: q.id, notebookId, title: q.title, createdAt: q.createdAt, questionCount: q.questions.length, attempts: at.length, best: pct.length ? Math.max(...pct) : null, last: pct.at(-1) ?? null };
    }).reverse()),
    quiz: (id: number) => mutate((db) => { const q = db.quizzes.find((x) => x.id === id); if (!q) throw 'Quiz not found.'; return q; }),
    createQuiz: (notebookId: number, title: string, questions: QuizQuestion[]) => mutate((db) => { const id = db.next++; db.quizzes.push({ id, notebookId, title, questions, createdAt: Date.now() }); return id; }),
    updateQuiz: (id: number, questions: QuizQuestion[]) => mutate((db) => {
      const q = db.quizzes.find((x) => x.id === id);
      if (q) q.questions = questions;
    }),
    renameQuiz: (id: number, title: string) => mutate((db) => {
      const q = db.quizzes.find((x) => x.id === id);
      if (q) q.title = title.trim().slice(0, 200);
    }),
    deleteQuiz: (id: number) => mutate((db) => { db.quizzes = db.quizzes.filter((q) => q.id !== id); }),
    addAttempt: (quizId: number, startedAt: number, score: number, total: number, answers: AttemptAnswer[]) => mutate((db) => {
      const q = db.quizzes.find((x) => x.id === quizId);
      if (!q) throw 'Quiz not found.';
      const id = db.next++;
      db.attempts.push({ id, quizId, quizTitle: q.title, startedAt, finishedAt: Date.now(), score, total, answers, notebookId: q.notebookId });
      return id;
    }),
    attempts: (notebookId: number, since: number) => mutate((db) => db.attempts.filter((a) => a.notebookId === notebookId && a.finishedAt >= since).map(({ notebookId: _n, ...a }) => a)),

    sources: (notebookId: number) => mutate((db) => db.sources.filter((s) => s.notebookId === notebookId).map(({ data: _d, ...s }) => s)),
    addSource: (x: { notebookId: number; kind: Source['kind']; title: string; filename?: string | null; mime?: string | null; data?: string | null; url?: string | null }) => mutate((db) => {
      const s = {
        id: db.next++, notebookId: x.notebookId, kind: x.kind, title: x.title, filename: x.filename ?? null, mime: x.mime ?? '', size: x.data ? Math.round(x.data.length * 0.75) : 0,
        url: x.url ?? null, status: 'processing' as const, error: null, unitCount: 0, charCount: 0, createdAt: Date.now(), data: x.data ?? null,
      };
      db.sources.push(s);
      const { data: _d, ...out } = s;
      return out;
    }),
    setSourceContent: (id: number, units: { label: string; text: string }[]) => mutate((db) => {
      const s = db.sources.find((x) => x.id === id);
      if (!s) throw 'Source not found.';
      db.units = db.units.filter((u) => u.sourceId !== id).concat(units.map((u, i) => ({ ...u, ord: i, sourceId: id })));
      Object.assign(s, { status: 'ready', error: null, unitCount: units.length, charCount: units.reduce((a, u) => a + u.text.length, 0) });
      const { data: _d, ...out } = s;
      return out;
    }),
    setSourceReport: (id: number, report: ExtractionReport) => mutate((db) => {
      const src = db.sources.find((x) => x.id === id);
      if (src) src.report = report;
    }),
    setSourceStatus: (id: number, status: Source['status'], error: string | null = null) => mutate((db) => { const s = db.sources.find((x) => x.id === id); if (s) Object.assign(s, { status, error }); }),
    renameSource: (id: number, title: string) => mutate((db) => { const s = db.sources.find((x) => x.id === id); if (s) s.title = clean(title); }),
    deleteSource: (id: number) => mutate((db) => { db.sources = db.sources.filter((s) => s.id !== id); db.units = db.units.filter((u) => u.sourceId !== id); }),
    sourceUnits: (id: number) => mutate((db) => db.units.filter((u) => u.sourceId === id).map(({ sourceId: _s, ...u }) => u)),
    sourceData: (id: number) => mutate((db) => { const s = db.sources.find((x) => x.id === id); if (!s?.data) throw 'This source has no file.'; return s.data; }),
    searchSources: (ids: number[], query: string, limit = 10) => mutate((db) => {
      const q = words(query);
      return hitsFor(db, ids)
        .map((h) => ({ ...h, score: [...words(h.text)].filter((w) => q.has(w)).length }))
        .filter((h) => h.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    }),
    sampleSources: (ids: number[]) => mutate((db) => hitsFor(db, ids)),
    youtubeTranscript: async (url: string) => {
      await new Promise((r) => setTimeout(r, 600));
      if (!/youtu/.test(url)) throw 'Only YouTube links are supported.';
      return {
        title: 'Lines and planes in space', channel: 'Mock Maths', duration: 600, chapters: [{ start: 0, title: 'Intro' }, { start: 240, title: 'Symmetric equations' }],
        segments: Array.from({ length: 40 }, (_, i) => ({ start: i * 15, text: i < 16 ? 'the vector equation of a line is r equals r0 plus t times v' : 'solving each component for t gives the symmetric equations' })),
      };
    },
    openUrl: async (url: string) => { window.open(url, '_blank'); },
  } satisfies typeof studyApi);
}
