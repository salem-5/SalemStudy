/**
 * Study sessions that survive being interrupted.
 *
 * Closing a quiz halfway through, switching notebooks, or quitting the app
 * should not throw away twenty minutes of work. Each quiz and each deck keeps
 * its own in-progress session — the answers given, the cards already seen,
 * where the student was — until it is finished or abandoned on purpose.
 *
 * Finished attempts and runs still go to SQLite; this is only the live state
 * of a session that has not ended yet.
 */

export type QuizAnswer = {
  given: string;
  correct: boolean;
  ms: number;
  /** Whether the hint was opened before answering — recorded, not penalised. */
  hinted?: boolean;
  feedback?: string;
};

export type QuizSession = {
  quizId: number;
  startedAt: number;
  /** Which question is on screen. */
  pos: number;
  /** Only these question indexes are in play (a "retry missed" run). */
  only?: number[];
  /** By question index, so it survives the quiz being reordered in review. */
  answers: Record<number, QuizAnswer>;
  /** Answers typed but not yet checked, so a half-typed answer is not lost. */
  drafts?: Record<number, string>;
  /** True once the student has finished and is reviewing. */
  reviewing?: boolean;
  updatedAt: number;
};

export type DeckSession = {
  deckId: number;
  startedAt: number;
  pos: number;
  /** Card ids in the order this session is playing them. */
  order: number[];
  /** By card id, so shuffling between sessions cannot corrupt it. */
  results: Record<number, { correct: boolean; elapsedMs: number }>;
  updatedAt: number;
};

const PREFIX = 'wa.session.';
/** A session nobody has touched for a fortnight is not going to be resumed. */
const MAX_AGE = 14 * 24 * 60 * 60 * 1000;

const key = (kind: 'quiz' | 'deck', id: number) => `${PREFIX}${kind}.${id}`;

function read<T extends { updatedAt: number }>(kind: 'quiz' | 'deck', id: number): T | null {
  try {
    const raw = localStorage.getItem(key(kind, id));
    if (!raw) return null;
    const value = JSON.parse(raw) as T;
    if (!value || typeof value.updatedAt !== 'number') return null;
    if (Date.now() - value.updatedAt > MAX_AGE) {
      localStorage.removeItem(key(kind, id));
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function write(kind: 'quiz' | 'deck', id: number, value: unknown): void {
  try {
    localStorage.setItem(key(kind, id), JSON.stringify(value));
  } catch {
    // A full or blocked localStorage costs the resume, not the session.
  }
}

export const loadQuizSession = (quizId: number) => read<QuizSession>('quiz', quizId);
export const saveQuizSession = (s: Omit<QuizSession, 'updatedAt'>) =>
  write('quiz', s.quizId, { ...s, updatedAt: Date.now() });
export const clearQuizSession = (quizId: number) => {
  try { localStorage.removeItem(key('quiz', quizId)); } catch { /* ignore */ }
};

export const loadDeckSession = (deckId: number) => read<DeckSession>('deck', deckId);
export const saveDeckSession = (s: Omit<DeckSession, 'updatedAt'>) =>
  write('deck', s.deckId, { ...s, updatedAt: Date.now() });
export const clearDeckSession = (deckId: number) => {
  try { localStorage.removeItem(key('deck', deckId)); } catch { /* ignore */ }
};

/**
 * Is this saved quiz session still worth offering?
 *
 * A quiz can be regenerated or edited under a saved session. Rather than
 * showing answers against questions they were never given, a session whose
 * question count no longer matches is dropped.
 */
export function quizSessionFits(session: QuizSession | null, questionCount: number): session is QuizSession {
  if (!session) return false;
  const answered = Object.keys(session.answers).map(Number);
  if (answered.some((i) => i >= questionCount)) return false;
  return session.pos <= questionCount;
}

/** Is this saved deck session still playable against the deck as it is now? */
export function deckSessionFits(session: DeckSession | null, cardIds: number[]): session is DeckSession {
  if (!session) return false;
  const live = new Set(cardIds);
  // Cards deleted since the session started are dropped from the order, but a
  // session that has lost most of its deck is not worth resuming.
  const surviving = session.order.filter((id) => live.has(id));
  return surviving.length >= Math.max(1, Math.floor(session.order.length * 0.6));
}

/** The saved session with deleted cards removed and the position kept sane. */
export function pruneDeckSession(session: DeckSession, cardIds: number[]): DeckSession {
  const live = new Set(cardIds);
  const order = session.order.filter((id) => live.has(id));
  const seen = order.slice(0, session.pos).length;
  const results = Object.fromEntries(Object.entries(session.results).filter(([id]) => live.has(Number(id))));
  return { ...session, order, results, pos: Math.min(session.pos, seen, order.length) };
}

export const answeredCount = (session: QuizSession | null) => (session ? Object.keys(session.answers).length : 0);
