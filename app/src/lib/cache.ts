import type { Assignment, Question } from '../types';
import { questionStatus } from './format';

// Questions are cached in memory for the life of the app run. Switching back to
// an assignment reuses the cache instead of refetching, completed assignments
// are never refetched, and a per-session budget caps how often the rest get
// refreshed. The TTL keeps cached data from going stale.

const TTL_MS = 5 * 60 * 1000;
const MAX_REFETCHES = 12;

type Entry = { assignment: Assignment; fetchedAt: number };
const store = new Map<number, Entry>();
let refetchCount = 0;

export const CACHE_TTL_MS = TTL_MS;
export const MAX_REFETCHES_PER_SESSION = MAX_REFETCHES;

export const isAssignmentComplete = (a: Assignment): boolean =>
  a.questions.length > 0 && a.questions.every((q) => questionStatus(q) === 'correct');

export const cachedAssignment = (id: number): Assignment | null => store.get(id)?.assignment ?? null;

export const cacheAge = (id: number): number | null => {
  const e = store.get(id);
  return e ? Date.now() - e.fetchedAt : null;
};

export const refetchesLeft = (): number => Math.max(0, MAX_REFETCHES - refetchCount);
export const canRefetch = (): boolean => refetchCount < MAX_REFETCHES;
export const recordRefetch = (): void => { refetchCount += 1; };

export function cacheAssignment(a: Assignment): void {
  store.set(a.id, { assignment: a, fetchedAt: Date.now() });
}

/** Fold a freshly graded/saved question into the cached assignment. */
export function updateCachedQuestion(dep: number, q: Question): void {
  const e = store.get(dep);
  if (!e) return;
  e.assignment = {
    ...e.assignment,
    questions: e.assignment.questions.map((x) => (x.number === q.number ? { ...q, html: q.html ?? x.html } : x)),
  };
}

export function clearCache(): void {
  store.clear();
  refetchCount = 0;
}
