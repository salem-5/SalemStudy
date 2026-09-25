export type QuizAnswer = {
  given: string;
  correct: boolean;
  ms: number;
  hinted?: boolean;
  feedback?: string;
  /** Diagram questions only: the per-label verdicts as they were marked, AI passes included. */
  labels?: boolean[];
  /** Diagram questions only: per label, why it was accepted or what was named instead. */
  labelNotes?: string[];
};

export type QuizSession = {
  quizId: number;
  startedAt: number;
  pos: number;
  only?: number[];
  answers: Record<number, QuizAnswer>;
  drafts?: Record<number, string>;
  reviewing?: boolean;
  updatedAt: number;
};

export type DeckSession = {
  deckId: number;
  startedAt: number;
  pos: number;
  order: number[];
  results: Record<number, { correct: boolean; elapsedMs: number }>;
  updatedAt: number;
};

const PREFIX = 'wa.session.';
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
  }
}

export const loadQuizSession = (quizId: number) => read<QuizSession>('quiz', quizId);
export const saveQuizSession = (s: Omit<QuizSession, 'updatedAt'>) =>
  write('quiz', s.quizId, { ...s, updatedAt: Date.now() });
export const clearQuizSession = (quizId: number) => {
  try { localStorage.removeItem(key('quiz', quizId)); } catch { }
};

export const loadDeckSession = (deckId: number) => read<DeckSession>('deck', deckId);
export const saveDeckSession = (s: Omit<DeckSession, 'updatedAt'>) =>
  write('deck', s.deckId, { ...s, updatedAt: Date.now() });
export const clearDeckSession = (deckId: number) => {
  try { localStorage.removeItem(key('deck', deckId)); } catch { }
};

export function quizSessionFits(session: QuizSession | null, questionCount: number): session is QuizSession {
  if (!session) return false;
  const answered = Object.keys(session.answers).map(Number);
  if (answered.some((i) => i >= questionCount)) return false;
  return session.pos <= questionCount;
}

export function deckSessionFits(session: DeckSession | null, cardIds: number[]): session is DeckSession {
  if (!session) return false;
  const live = new Set(cardIds);
  const surviving = session.order.filter((id) => live.has(id));
  return surviving.length >= Math.max(1, Math.floor(session.order.length * 0.6));
}

export function pruneDeckSession(session: DeckSession, cardIds: number[]): DeckSession {
  const live = new Set(cardIds);
  const order = session.order.filter((id) => live.has(id));
  const seen = order.slice(0, session.pos).length;
  const results = Object.fromEntries(Object.entries(session.results).filter(([id]) => live.has(Number(id))));
  return { ...session, order, results, pos: Math.min(session.pos, seen, order.length) };
}

export const answeredCount = (session: QuizSession | null) => (session ? Object.keys(session.answers).length : 0);

/**
 * Where to pick a quiz back up: the first question in its order that has no answer yet, so
 * questions skipped with Next are not left behind. With every one answered, where it was left.
 */
export function quizResumeAt(session: Pick<QuizSession, 'answers' | 'pos'>, order: number[]): number {
  const at = order.findIndex((i) => session.answers[i] === undefined);
  return at >= 0 ? at : Math.max(0, Math.min(session.pos, order.length - 1));
}

/** The same for a deck: the first card in the saved order not yet marked right or wrong. */
export function deckResumeAt(session: Pick<DeckSession, 'order' | 'results' | 'pos'>): number {
  const at = session.order.findIndex((id) => session.results[id] === undefined);
  return at >= 0 ? at : Math.min(session.pos, session.order.length);
}

/** How many cards of a saved run have been marked, which is what "seen" means to the student. */
export const deckMarkedCount = (session: Pick<DeckSession, 'order' | 'results'>) =>
  session.order.filter((id) => session.results[id] !== undefined).length;
