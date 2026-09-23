import { invoke } from '@tauri-apps/api/core';
import type { Reference } from '../lib/reference';

/** Study data lives in SQLite on the Rust side (src-tauri/src/study*.rs). */

export type NotebookSummary = {
  id: number;
  subjectId: number;
  name: string;
  description: string;
  sourceCount: number;
  cardCount: number;
  quizCount: number;
  deckCount: number;
  noteCount: number;
  /** AI-written list of what the notebook covers; '' until generated. */
  overview: string;
  overviewAt: number;
  updatedAt: number;
};

export type SubjectNode = {
  id: number;
  name: string;
  /** Course-wide notes (syllabus, notation) every notebook in the subject inherits. */
  context: string;
  /** Lucide icon name and accent colour ('' = defaults). */
  icon: string;
  color: string;
  /** Syllabus file name ('' = none), the AI's summary of it, and when it was added. */
  syllabusName: string;
  syllabusSummary: string;
  syllabusAt: number;
  notebooks: NotebookSummary[];
};

export type EventKind = 'exam' | 'deadline' | 'study' | 'class' | 'other';

export type StudyEvent = {
  id: number;
  title: string;
  notes: string;
  kind: EventKind;
  startAt: number;
  endAt: number | null;
  allDay: boolean;
  notebookId: number | null;
  /** The course it belongs to, or null (shown grey). A notebook's events take its course. */
  subjectId: number | null;
  done: boolean;
};

export type EventInput = Omit<StudyEvent, 'id'>;

export type Found = {
  kind: 'source' | 'note' | 'card' | 'chat';
  id: number;
  notebookId: number | null;
  title: string;
  detail: string;
  snippet: string;
  /** Source: the unit (page, slide) to open at. Card: its deck. */
  target: number | null;
};

/** A fact the AI remembers about the student. */
export type Memory = { id: number; text: string; source: 'chat' | 'user'; createdAt: number; updatedAt: number };
export type MemoryState = { items: Memory[]; used: number; capacity: number };

/** One study action, for the activity view's day breakdown. */
export type ActivityEntry = {
  at: number;
  kind: 'card' | 'quiz' | 'chat' | 'note' | 'source' | 'focus';
  notebookId: number | null;
  notebook: string | null;
  subject: string | null;
};

export type UsageBucket = { key: string; calls: number; tokens: number; cost: number };
export type UsageSummary = { total: UsageBucket; last30: UsageBucket; byFeature: UsageBucket[]; byModel: UsageBucket[]; byDay: UsageBucket[]; since: number | null };

export type SourceImage = { id: number; unitOrd: number; caption: string };

export type ChatThread = {
  id: number;
  notebookId: number | null;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
};

export type AttachmentInfo = {
  id: number;
  kind: 'upload' | 'figure' | string;
  name: string;
  mime: string;
  size: number;
  text: string | null;
};

/** One sandboxed Python call made while answering. */
export type PythonRun = {
  id: string;
  code: string;
  ok: boolean;
  /** What the model was shown (stdout, value, error), clipped. */
  output: string;
  figures: number[];
  running?: boolean;
};

/** Something the assistant did in the app on the user's request. */
export type AppAction = { id: string; name: string; label: string; ok: boolean; detail?: string; running?: boolean };

/** The order text, Python runs and app actions appeared in, so a reply renders as written. */
export type Step = { type: 'text'; text: string } | { type: 'run'; id: string } | { type: 'action'; id: string };

export type MessageMeta = {
  attachments?: AttachmentInfo[];
  /** What was pointed at when this message was sent — a selection in a note,
   *  a quiz question, a card. Carried with the message the way a file is,
   *  because that is when it was meant. */
  references?: Reference[];
  runs?: PythonRun[];
  steps?: Step[];
  actions?: AppAction[];
  /** Source excerpts the answer could cite, numbered as in the reply. */
  citations?: { n: number; sourceId: number; title: string; label: string; unit: number }[];
  error?: string;
  model?: string;
  /** Thinking mode: what the model reasoned before answering, and for how long. */
  reasoning?: string;
  thoughtMs?: number;
  /** What writing this reply cost, in USD. */
  cost?: number;
} | null;

export type ChatMessage = {
  id: number;
  role: 'user' | 'assistant' | 'system' | 'event';
  content: string;
  meta: MessageMeta;
  createdAt: number;
};

/** A named set of flashcards, replayed for a score. */
export type Deck = {
  id: number;
  notebookId: number;
  title: string;
  createdAt: number;
  updatedAt: number;
  cardCount: number;
  runs: number;
  /** Share right (0..1) of the best and the latest run. */
  best: number | null;
  last: number | null;
};

export type Card = {
  id: number;
  deckId: number;
  notebookId: number;
  front: string;
  back: string;
  topic: string;
  sourceRefs: unknown;
  createdAt: number;
  reviews: number;
  misses: number;
  lastCorrect: boolean | null;
};

export type NewCard = { front: string; back: string; topic?: string; sourceRefs?: unknown };

export type CardResult = { cardId: number; correct: boolean; elapsedMs: number };

export type Review = { cardId: number; correct: boolean; elapsedMs: number; reviewedAt: number; topic: string };

export type DeckRun = { id: number; deckId: number; deckTitle: string; startedAt: number; finishedAt: number; correct: number; total: number };

export type Note = {
  id: number;
  notebookId: number;
  title: string;
  content: string;
  instructions: string;
  createdAt: number;
  updatedAt: number;
};

export type SourceKind = 'pdf' | 'slides' | 'image' | 'text' | 'youtube' | 'file';

/** How reading a source went. Null until it has been read. */
export type ExtractionReport = {
  pages: number;
  characters: number;
  /** 1-based page numbers that came back with nothing on them. */
  empty: number[];
  /** Pages identical to an earlier one — an extractor repeating itself. */
  duplicated: number[];
  /** Scanned pages that had to be transcribed by the vision model. */
  transcribed?: number;
  /** Pages whose figures were described. */
  described?: number;
  /** Pages with figures that were past the limit and not looked at. */
  skipped?: number;
  at: number;
};

export type Source = {
  id: number;
  notebookId: number;
  kind: SourceKind;
  title: string;
  filename: string | null;
  mime: string;
  size: number;
  url: string | null;
  status: 'processing' | 'ready' | 'error';
  error: string | null;
  unitCount: number;
  charCount: number;
  createdAt: number;
  report?: ExtractionReport | null;
};

export type SourceUnit = { ord: number; label: string; text: string };

export type SourceHit = {
  chunkId: number;
  sourceId: number;
  sourceTitle: string;
  kind: SourceKind;
  unitFrom: number;
  unitTo: number;
  label: string;
  text: string;
  score: number;
};

export type YoutubeTranscript = {
  title: string | null;
  channel: string | null;
  duration: number | null;
  chapters: { start: number; title: string }[];
  segments: { start: number; text: string }[];
};

export type QuestionType = 'mcq' | 'multi' | 'tf' | 'numeric' | 'short' | 'blank';

export type Difficulty = 'easy' | 'medium' | 'hard';

/** Where a question came from, so a claim can be traced back to its source. */
export type QuestionSource = { sourceId: number; title: string; label: string; unit: number };

export type QuizQuestion = {
  type: QuestionType;
  prompt: string;
  /** mcq and multi. */
  choices?: string[];
  /** mcq: index of the right choice; tf: "true"/"false"; numeric: the number;
   *  short: reference answer; blank: the word or phrase that fills the gap. */
  answer: string | number;
  /** multi only: the indexes of every correct choice. */
  answers?: number[];
  /** blank only: other spellings or forms that should also be accepted. */
  accept?: string[];
  tolerance?: number;
  unit?: string;
  explanation: string;
  /** A nudge that helps the student reason or recall without giving the
   *  answer away. Shown only when asked for. */
  hint?: string;
  topic: string;
  difficulty?: Difficulty;
  /** The source passages this question came from, when it is source-backed. */
  sources?: QuestionSource[];
  /** Attachment id of a matplotlib figure shown with the question. */
  figure?: number | null;
  /** True when a Python check reproduced the answer. */
  verified?: boolean;
};

export type QuizSummary = {
  id: number;
  notebookId: number;
  title: string;
  createdAt: number;
  questionCount: number;
  attempts: number;
  best: number | null;
  last: number | null;
};

export type Quiz = { id: number; notebookId: number; title: string; questions: QuizQuestion[]; createdAt: number };

export type AttemptAnswer = {
  index: number;
  given: string;
  correct: boolean;
  topic: string;
  ms: number;
  /** Whether the student opened the hint before answering. */
  hinted?: boolean;
};

export type Attempt = {
  id: number;
  quizId: number;
  quizTitle: string;
  startedAt: number;
  finishedAt: number;
  score: number;
  total: number;
  answers: AttemptAnswer[];
};

export const studyApi = {
  tree: () => invoke<SubjectNode[]>('study_tree'),
  createSubject: (name: string) => invoke<number>('study_create_subject', { name }),
  updateSubject: (id: number, patch: { name?: string; context?: string; icon?: string; color?: string }) =>
    invoke<void>('study_update_subject', { id, name: patch.name ?? null, context: patch.context ?? null, icon: patch.icon ?? null, color: patch.color ?? null }),
  setSyllabus: (subjectId: number, s: { file: number | null; name: string; text: string; summary: string }) =>
    invoke<void>('syllabus_set', { subjectId, file: s.file, name: s.name, text: s.text, summary: s.summary }),
  clearSyllabus: (subjectId: number) => invoke<void>('syllabus_clear', { subjectId }),
  syllabusText: (subjectId: number) => invoke<string>('syllabus_text', { subjectId }),
  setOverview: (id: number, overview: string) => invoke<void>('notebook_set_overview', { id, overview }),
  /** Timestamps of study actions since `since`. */
  activity: (since: number) => invoke<number[]>('activity', { since }),
  /** What was studied between two moments, with where each action happened. */
  activityDetail: (from: number, to: number) => invoke<ActivityEntry[]>('activity_detail', { from, to }),
  /** Log a focus session the student finished (breaks are not study). */
  addFocusSession: (phase: string, startedAt: number, finishedAt: number, tasksDone: number) =>
    invoke<void>('focus_session_add', { phase, startedAt, finishedAt, tasksDone }),
  /** Finished focus sessions since `since`, as [finishedAt, minutes] pairs. */
  focusMinutes: (since: number) => invoke<[number, number][]>('focus_minutes', { since }),
  usage: () => invoke<UsageSummary>('usage_summary'),
  memories: () => invoke<MemoryState>('memory_list'),
  addMemory: (text: string, source: 'chat' | 'user' = 'chat') => invoke<Memory>('memory_add', { text, source }),
  updateMemory: (id: number, text: string) => invoke<void>('memory_update', { id, text }),
  deleteMemory: (id: number) => invoke<void>('memory_delete', { id }),
  clearMemories: () => invoke<number>('memory_clear'),
  resetUsage: () => invoke<void>('usage_reset'),
  events: (from: number, to: number) => invoke<StudyEvent[]>('events_between', { from, to }),
  addEvent: (event: EventInput) => invoke<StudyEvent>('event_add', { event }),
  updateEvent: (id: number, event: EventInput) => invoke<StudyEvent>('event_update', { id, event }),
  deleteEvent: (id: number) => invoke<void>('event_delete', { id }),
  searchEverything: (query: string) => invoke<Found[]>('search_everything', { query }),
  addSourceImage: (sourceId: number, unitOrd: number, mime: string, data: string, caption: string) =>
    invoke<number>('source_image_add', { sourceId, unitOrd, mime, data, caption }),
  clearSourceImages: (sourceId: number) => invoke<void>('source_images_clear', { sourceId }),
  sourceImages: (sourceId: number) => invoke<SourceImage[]>('source_images', { sourceId }),
  sourceImageData: (id: number) => invoke<string>('source_image_data', { id }),
  deleteSubject: (id: number) => invoke<void>('study_delete_subject', { id }),
  createNotebook: (subjectId: number, name: string, description?: string) =>
    invoke<number>('study_create_notebook', { subjectId, name, description: description ?? null }),
  updateNotebook: (id: number, patch: { name?: string; description?: string }) =>
    invoke<void>('study_update_notebook', { id, name: patch.name ?? null, description: patch.description ?? null }),
  deleteNotebook: (id: number) => invoke<void>('study_delete_notebook', { id }),

  chatList: (notebookId: number | null) => invoke<ChatThread[]>('chat_list', { notebookId }),
  chatCreate: (notebookId: number | null, title = '') => invoke<ChatThread>('chat_create', { notebookId, title }),
  chatRename: (id: number, title: string) => invoke<void>('chat_rename', { id, title }),
  chatDelete: (id: number) => invoke<void>('chat_delete', { id }),
  /** Empty a chat but keep it. */
  chatClear: (id: number) => invoke<void>('chat_clear', { id }),
  /** Delete a message and everything after it (regenerate / edit). */
  chatTruncate: (conversationId: number, fromId: number) => invoke<number>('chat_truncate', { conversationId, fromId }),
  /** Delete every chat in the Chat tab (null) or in one notebook. */
  chatDeleteAll: (notebookId: number | null) => invoke<number>('chat_delete_all', { notebookId }),

  notes: (notebookId: number) => invoke<Note[]>('notes_list', { notebookId }),
  note: (id: number) => invoke<Note>('note_get', { id }),
  createNote: (notebookId: number, title: string, content: string, instructions = '') =>
    invoke<Note>('note_create', { notebookId, title, content, instructions }),
  updateNote: (id: number, patch: { title?: string; content?: string; instructions?: string }) =>
    invoke<Note>('note_update', { id, title: patch.title ?? null, content: patch.content ?? null, instructions: patch.instructions ?? null }),
  deleteNote: (id: number) => invoke<void>('note_delete', { id }),
  chatMessages: (id: number) => invoke<ChatMessage[]>('chat_messages', { id }),
  chatAddMessage: (conversationId: number, role: ChatMessage['role'], content: string, meta: MessageMeta = null) =>
    invoke<ChatMessage>('chat_add_message', { conversationId, role, content, meta }),

  attachmentAdd: (a: { conversationId?: number | null; notebookId?: number | null; kind: string; name: string; mime: string; data: string; text?: string | null }) =>
    invoke<AttachmentInfo>('attachment_add', {
      conversationId: a.conversationId ?? null,
      notebookId: a.notebookId ?? null,
      kind: a.kind,
      name: a.name,
      mime: a.mime,
      data: a.data,
      text: a.text ?? null,
    }),
  attachmentData: (id: number) => invoke<string>('attachment_data', { id }),
  attachmentSetText: (id: number, text: string) => invoke<void>('attachment_set_text', { id, text }),
  attachmentsInfo: (ids: number[]) => invoke<AttachmentInfo[]>('attachments_info', { ids }),

  decks: (notebookId: number) => invoke<Deck[]>('decks_list', { notebookId }),
  createDeck: (notebookId: number, title: string, cards: NewCard[]) =>
    invoke<number>('deck_create', { notebookId, title, cards: cards.map((c) => ({ topic: '', sourceRefs: null, ...c })) }),
  renameDeck: (id: number, title: string) => invoke<void>('deck_rename', { id, title }),
  deleteDeck: (id: number) => invoke<void>('deck_delete', { id }),
  deckCards: (deckId: number) => invoke<Card[]>('deck_cards', { deckId }),
  addCards: (deckId: number, cards: NewCard[]) =>
    invoke<number[]>('cards_add', { deckId, cards: cards.map((c) => ({ topic: '', sourceRefs: null, ...c })) }),
  updateCard: (id: number, front: string, back: string, topic: string) => invoke<void>('card_update', { id, front, back, topic }),
  deleteCard: (id: number) => invoke<void>('card_delete', { id }),
  addDeckRun: (deckId: number, startedAt: number, results: CardResult[]) => invoke<number>('deck_run_add', { deckId, startedAt, results }),
  deckRuns: (notebookId: number, since: number) => invoke<DeckRun[]>('deck_runs_list', { notebookId, since }),
  reviews: (notebookId: number, since: number) => invoke<Review[]>('reviews_list', { notebookId, since }),

  sources: (notebookId: number) => invoke<Source[]>('sources_list', { notebookId }),
  addSource: (s: { notebookId: number; kind: SourceKind; title: string; filename?: string | null; mime?: string | null; data?: string | null; url?: string | null }) =>
    invoke<Source>('source_add', { notebookId: s.notebookId, kind: s.kind, title: s.title, filename: s.filename ?? null, mime: s.mime ?? null, data: s.data ?? null, url: s.url ?? null }),
  setSourceContent: (id: number, units: { label: string; text: string }[]) => invoke<Source>('source_set_content', { id, units }),
  setSourceStatus: (id: number, status: Source['status'], error: string | null = null) => invoke<void>('source_set_status', { id, status, error }),
  /** Record how reading a source went — empty pages, transcriptions, repeats. */
  setSourceReport: (id: number, report: ExtractionReport) => invoke<void>('source_set_report', { id, report }),
  renameSource: (id: number, title: string) => invoke<void>('source_rename', { id, title }),
  deleteSource: (id: number) => invoke<void>('source_delete', { id }),
  sourceUnits: (id: number) => invoke<SourceUnit[]>('source_units', { id }),
  sourceData: (id: number) => invoke<string>('source_data', { id }),
  searchSources: (sourceIds: number[], query: string, limit = 10) => invoke<SourceHit[]>('sources_search', { sourceIds, query, limit }),
  sampleSources: (sourceIds: number[], maxChars = 60_000) => invoke<SourceHit[]>('sources_sample', { sourceIds, maxChars }),
  youtubeTranscript: (url: string) => invoke<YoutubeTranscript>('youtube_transcript', { url }),
  openUrl: (url: string) => invoke<void>('open_url', { url }),

  quizzes: (notebookId: number) => invoke<QuizSummary[]>('quizzes_list', { notebookId }),
  quiz: (id: number) => invoke<Quiz>('quiz_get', { id }),
  createQuiz: (notebookId: number, title: string, questions: QuizQuestion[]) =>
    invoke<number>('quiz_create', { notebookId, title, questions }),
  /** Replace a quiz's questions (editing one, or rewriting one in place). */
  updateQuiz: (id: number, questions: QuizQuestion[]) => invoke<void>('quiz_update', { id, questions }),
  renameQuiz: (id: number, title: string) => invoke<void>('quiz_rename', { id, title }),
  deleteQuiz: (id: number) => invoke<void>('quiz_delete', { id }),
  addAttempt: (quizId: number, startedAt: number, score: number, total: number, answers: AttemptAnswer[]) =>
    invoke<number>('quiz_attempt_add', { quizId, startedAt, score, total, answers }),
  attempts: (notebookId: number, since: number) => invoke<Attempt[]>('attempts_list', { notebookId, since }),
};

