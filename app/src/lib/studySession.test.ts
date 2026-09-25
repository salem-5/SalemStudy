import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

let store: Map<string, string>;
let sessions: typeof import('./studySession');

before(async () => {
  store = new Map();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  sessions = await import('./studySession.ts');
});

const quiz = (over: Partial<import('./studySession').QuizSession> = {}) => ({
  quizId: 1,
  startedAt: 1000,
  pos: 2,
  answers: { 0: { given: '0', correct: true, ms: 900 }, 1: { given: '1', correct: false, ms: 1200 } },
  ...over,
});

describe('quiz sessions', () => {
  it('comes back with every answer intact', () => {
    sessions.saveQuizSession(quiz());
    const back = sessions.loadQuizSession(1);
    assert.equal(back?.pos, 2);
    assert.equal(sessions.answeredCount(back), 2);
    assert.equal(back?.answers[1].correct, false);
  });

  it('keeps a half-typed answer', () => {
    sessions.saveQuizSession(quiz({ quizId: 2, drafts: { 3: '9.8' } }));
    assert.equal(sessions.loadQuizSession(2)?.drafts?.[3], '9.8');
  });

  it('keeps each quiz separate', () => {
    sessions.saveQuizSession(quiz({ quizId: 10, pos: 1 }));
    sessions.saveQuizSession(quiz({ quizId: 11, pos: 7 }));
    assert.equal(sessions.loadQuizSession(10)?.pos, 1);
    assert.equal(sessions.loadQuizSession(11)?.pos, 7);
  });

  it('is gone once it is cleared', () => {
    sessions.saveQuizSession(quiz({ quizId: 3 }));
    sessions.clearQuizSession(3);
    assert.equal(sessions.loadQuizSession(3), null);
  });

  it('is not offered once it has gone stale', () => {
    store.set('wa.session.quiz.4', JSON.stringify({ ...quiz({ quizId: 4 }), updatedAt: Date.now() - 30 * 86_400_000 }));
    assert.equal(sessions.loadQuizSession(4), null);
  });

  it('is refused when the quiz no longer has those questions', () => {
    const session = { ...quiz(), updatedAt: Date.now() };
    assert.equal(sessions.quizSessionFits(session, 8), true);
    assert.equal(sessions.quizSessionFits(session, 1), false, 'an answer for a question that is gone');
    assert.equal(sessions.quizSessionFits(null, 8), false);
  });

  it('survives a corrupted entry', () => {
    store.set('wa.session.quiz.5', '{{');
    assert.equal(sessions.loadQuizSession(5), null);
  });
});

describe('deck sessions', () => {
  const deck = () => ({
    deckId: 1,
    startedAt: 1000,
    pos: 2,
    order: [10, 11, 12, 13, 14],
    results: { 10: { correct: true, elapsedMs: 800 }, 11: { correct: false, elapsedMs: 1500 } },
  });

  it('comes back with the cards already reviewed', () => {
    sessions.saveDeckSession(deck());
    const back = sessions.loadDeckSession(1);
    assert.equal(back?.pos, 2);
    assert.equal(back?.results[11].correct, false);
    assert.deepEqual(back?.order, [10, 11, 12, 13, 14]);
  });

  it('is still playable when a card or two were deleted', () => {
    const session = { ...deck(), updatedAt: Date.now() };
    assert.equal(sessions.deckSessionFits(session, [10, 11, 12, 13]), true);
    const pruned = sessions.pruneDeckSession(session, [10, 11, 12, 13]);
    assert.deepEqual(pruned.order, [10, 11, 12, 13]);
    assert.equal(pruned.pos, 2, 'the student stays where they were');
  });

  it('is refused when most of the deck is gone', () => {
    const session = { ...deck(), updatedAt: Date.now() };
    assert.equal(sessions.deckSessionFits(session, [10]), false);
  });

  it('drops the results of deleted cards when pruning', () => {
    const session = { ...deck(), updatedAt: Date.now() };
    const pruned = sessions.pruneDeckSession(session, [11, 12, 13, 14]);
    assert.equal(pruned.results[10], undefined);
    assert.equal(pruned.results[11].correct, false);
  });
});

describe('picking a run back up', () => {
  it('reopens a quiz on the first question left unanswered, not where Next got to', () => {
    const skipped = { pos: 5, answers: { 0: { given: 'a', correct: true, ms: 1 }, 2: { given: 'c', correct: false, ms: 1 } } };
    assert.equal(sessions.quizResumeAt(skipped, [0, 1, 2, 3, 4, 5]), 1);
  });

  it('follows the order of a retry of only some questions', () => {
    const retry = { pos: 1, answers: { 4: { given: 'x', correct: true, ms: 1 } } };
    assert.equal(sessions.quizResumeAt(retry, [4, 7, 9]), 1);
  });

  it('stays where it was when every question is answered', () => {
    const all = { pos: 1, answers: { 0: { given: 'a', correct: true, ms: 1 }, 1: { given: 'b', correct: true, ms: 1 } } };
    assert.equal(sessions.quizResumeAt(all, [0, 1]), 1);
  });

  it('reopens a deck on the first card not yet marked, and counts only marked cards as seen', () => {
    const run = { pos: 4, order: [10, 11, 12, 13, 14], results: { 10: { correct: true, elapsedMs: 1 }, 12: { correct: false, elapsedMs: 1 } } };
    assert.equal(sessions.deckResumeAt(run), 1);
    assert.equal(sessions.deckMarkedCount(run), 2);
  });
});
