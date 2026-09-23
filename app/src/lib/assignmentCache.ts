/**
 * Remembering WebAssign assignments between looks.
 *
 * The bridge only answers while a logged-in tab is open, and asking it for the
 * whole assignment list is slow. So the list is cached and *reconciled*
 * rather than replaced: a due date that moved is picked up and recorded as a
 * change, an assignment that has gone from WebAssign is marked rather than
 * quietly deleted, and everything keeps working from the cache when the
 * bridge is not there at all.
 *
 * Nothing here guesses. A due date is only ever what WebAssign said; when a
 * date cannot be read, the entry keeps the last one it had and says the
 * reading failed.
 */

export type CachedAssignment = {
  id: number;
  title: string;
  /** Epoch milliseconds, or null when WebAssign gave no usable date. */
  due: number | null;
  /** Exactly what WebAssign printed, kept beside the parsed value. */
  dueText: string;
  /** When we last saw it in a WebAssign listing. */
  seenAt: number;
  /** Set when it stopped appearing: kept, greyed, not deleted. */
  missingSince?: number;
  /** The previous due date, when it moved. Shown to the student once. */
  movedFrom?: number | null;
};

export type Reconciliation = {
  assignments: CachedAssignment[];
  added: CachedAssignment[];
  moved: { assignment: CachedAssignment; from: number | null; to: number | null }[];
  missing: CachedAssignment[];
  returned: CachedAssignment[];
};

export type Incoming = { id: number; title: string; due: number | null; dueText: string };

/** An assignment missing for this long is almost certainly gone for good. */
export const FORGET_AFTER = 60 * 24 * 60 * 60 * 1000;

/**
 * Fold a fresh WebAssign listing into what we already had.
 *
 * Pure, so the rules can be tested without a bridge or a browser.
 */
export function reconcile(cached: CachedAssignment[], incoming: Incoming[], now = Date.now()): Reconciliation {
  const before = new Map(cached.map((a) => [a.id, a]));
  const seen = new Set(incoming.map((a) => a.id));
  const out: CachedAssignment[] = [];
  const added: CachedAssignment[] = [];
  const moved: Reconciliation['moved'] = [];
  const returned: CachedAssignment[] = [];

  for (const fresh of incoming) {
    const old = before.get(fresh.id);
    if (!old) {
      const entry: CachedAssignment = { ...fresh, seenAt: now };
      added.push(entry);
      out.push(entry);
      continue;
    }
    // A date we could not read this time must not wipe the one we had.
    const due = fresh.due ?? old.due;
    const dueText = fresh.dueText || old.dueText;
    const changed = fresh.due !== null && fresh.due !== old.due;
    const entry: CachedAssignment = {
      id: fresh.id,
      title: fresh.title || old.title,
      due,
      dueText,
      seenAt: now,
      ...(changed ? { movedFrom: old.due } : old.movedFrom !== undefined ? { movedFrom: old.movedFrom } : {}),
    };
    if (changed) moved.push({ assignment: entry, from: old.due, to: fresh.due });
    if (old.missingSince !== undefined) returned.push(entry);
    out.push(entry);
  }

  const missing: CachedAssignment[] = [];
  for (const old of cached) {
    if (seen.has(old.id)) continue;
    // Long gone: stop carrying it.
    if (old.missingSince !== undefined && now - old.missingSince > FORGET_AFTER) continue;
    const entry: CachedAssignment = { ...old, missingSince: old.missingSince ?? now };
    missing.push(entry);
    out.push(entry);
  }

  out.sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity) || a.id - b.id);
  return { assignments: out, added, moved, missing, returned };
}

/** A line for the student about what changed, or null when nothing did. */
export function describeChanges(r: Reconciliation): string | null {
  const parts: string[] = [];
  if (r.added.length) parts.push(`${r.added.length} new`);
  if (r.moved.length) {
    const one = r.moved[0];
    parts.push(r.moved.length === 1
      ? `“${one.assignment.title}” moved to ${one.to === null ? 'no date' : new Date(one.to).toLocaleDateString()}`
      : `${r.moved.length} due dates moved`);
  }
  if (r.missing.length) parts.push(`${r.missing.length} no longer listed`);
  return parts.length ? parts.join(' · ') : null;
}

// ---------------------------------------------------------------- storage

const KEY = 'wa.assignments.v1';

export function loadCache(): CachedAssignment[] {
  try {
    const raw = localStorage.getItem(KEY);
    const value = raw ? JSON.parse(raw) : null;
    return Array.isArray(value) ? (value as CachedAssignment[]).filter((a) => typeof a?.id === 'number') : [];
  } catch {
    return [];
  }
}

export function saveCache(assignments: CachedAssignment[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(assignments));
  } catch {
    // A full localStorage costs the cache, not the feature.
  }
}

/** When the cache was last refreshed from WebAssign. */
export const lastSeen = (assignments: CachedAssignment[]): number =>
  assignments.reduce((latest, a) => Math.max(latest, a.seenAt), 0);

/** How stale the cache is allowed to get before it is worth asking again. */
export const REFRESH_AFTER = 10 * 60 * 1000;

export const needsRefresh = (assignments: CachedAssignment[], now = Date.now()): boolean =>
  !assignments.length || now - lastSeen(assignments) > REFRESH_AFTER;
