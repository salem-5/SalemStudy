import { useSyncExternalStore } from 'react';
import type { ExecState } from './types';
import type { Meter } from '../meter';
import { createStop, type Stop } from '../cancel.ts';

/**
 * Work the student started and does not have to sit and watch.
 *
 * Generating forty questions from a term's lecture notes takes minutes. It
 * should not hold the window hostage, and it should not vanish the moment
 * they navigate away — so it runs here, in a small store the whole app can
 * see, with a tray showing what is in flight and a way to stop it.
 *
 * The store is also where conflicting work is kept apart: a task claims a
 * *scope* (a notebook's quizzes, a deck, the schedule) and a second task
 * wanting the same scope is refused rather than allowed to race it. Two runs
 * writing the same rows is how a student loses work.
 */

export type TaskState = ExecState | 'queued';

export type BackgroundTask = {
  id: string;
  /** What to call it in the tray: "Writing a 40-question quiz". */
  label: string;
  /** Where it will write. Two tasks may not hold the same scope at once. */
  scope: string;
  state: TaskState;
  /** The runtime's current step, for the tray's second line. */
  detail: string;
  /**
   * Every step it has been through, with when.
   *
   * The tray has room for one line, which is enough to know it is alive and
   * not enough to know what it is doing. Watching a deck being written —
   * which pass it is on, which question failed its check and is being
   * replaced — needs the whole sequence, so it is kept.
   */
  log: { at: number; text: string }[];
  startedAt: number;
  finishedAt?: number;
  /** What its model calls have cost so far, in USD. */
  cost: number;
  error?: string;
  /** What to say when it worked: "Saved “Convergence tests” (12 questions)". */
  result?: string;
  /** How to stop it. The store does not know what the work is, so the caller
   *  supplies this — usually `() => cancelRun(runId)`. */
  stop?: () => void;
  /** Where to send the student when they click it. */
  open?: () => void;
};

export class ScopeBusy extends Error {
  /** The task that already has the scope, so the caller can name it. */
  readonly holder: BackgroundTask;

  constructor(holder: BackgroundTask) {
    super(`Already ${holder.label.toLowerCase()}. Wait for that to finish first.`);
    this.name = 'ScopeBusy';
    this.holder = holder;
  }
}

const tasks = new Map<string, BackgroundTask>();
const listeners = new Set<() => void>();
let snapshot: readonly BackgroundTask[] = [];

const changed = () => {
  snapshot = [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
  listeners.forEach((l) => l());
};

export function useTasks(): readonly BackgroundTask[] {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => snapshot,
  );
}

const live = (t: BackgroundTask) => !['completed', 'failed', 'cancelled'].includes(t.state);

/** The task holding `scope`, if one is. */
export const holderOf = (scope: string): BackgroundTask | undefined =>
  [...tasks.values()].find((t) => t.scope === scope && live(t));

/**
 * Run `work` in the background under `scope`.
 *
 * Throws `ScopeBusy` straight away if something else is already working on
 * the same thing — better a clear refusal than two jobs writing over each
 * other. The returned promise resolves when the work does; callers that do
 * not want to wait can simply ignore it.
 */
export async function runInBackground<T>(
  options: {
    label: string;
    scope: string;
    stop?: () => void;
    open?: () => void;
    /** Turned into the tray's one-line summary when it succeeds. */
    describe?: (result: T) => string;
  },
  work: (progress: (detail: string) => void, meter: Meter, stop: Stop) => Promise<T>,
): Promise<T> {
  const busy = holderOf(options.scope);
  if (busy) throw new ScopeBusy(busy);
  // Stop reaches the work itself, not just the tray: its passes stop, its
  // requests are cancelled, and nothing half-written is saved.
  const stop = createStop();

  const task: BackgroundTask = {
    id: crypto.randomUUID(),
    label: options.label,
    scope: options.scope,
    state: 'planning',
    detail: '',
    log: [],
    startedAt: Date.now(),
    cost: 0,
    stop: () => { stop.stop(); options.stop?.(); },
    open: options.open,
  };
  tasks.set(task.id, task);
  changed();

  const update = (patch: Partial<BackgroundTask>) => {
    const current = tasks.get(task.id);
    if (!current) return;
    tasks.set(task.id, { ...current, ...patch });
    changed();
  };

  const step = (detail: string) => {
    const current = tasks.get(task.id);
    // The same line twice running is the same step, not a new one.
    const log = current && current.log.at(-1)?.text !== detail
      ? [...(current?.log ?? []), { at: Date.now(), text: detail }].slice(-200)
      : current?.log ?? [];
    update({ state: 'executing', detail, log });
  };

  // What it costs, live: every call the work makes lands here. (A meter by
  // hand rather than `createMeter`, so this module stays importable by the
  // node tests without the rest of the app.)
  let spent = 0;
  const meter: Meter = {
    add(usd) {
      if (!Number.isFinite(usd) || usd <= 0) return;
      spent += usd;
      update({ cost: spent });
    },
    get total() { return spent; },
  };

  try {
    const result = await work(step, meter, stop);
    // Stopped just as it finished: it still does not count.
    stop.throwIfStopped();
    const done = options.describe?.(result) ?? '';
    update({
      state: 'completed',
      detail: done,
      result: options.describe?.(result),
      log: [...(tasks.get(task.id)?.log ?? []), { at: Date.now(), text: done || 'Done' }],
      finishedAt: Date.now(),
    });
    return result;
  } catch (e) {
    const message = String(e instanceof Error ? e.message : e);
    const stopped = message === 'stopped';
    update({
      state: stopped ? 'cancelled' : 'failed',
      error: stopped ? undefined : message,
      log: [...(tasks.get(task.id)?.log ?? []), { at: Date.now(), text: stopped ? 'Stopped' : message }],
      finishedAt: Date.now(),
    });
    throw e;
  }
}

/** Stop a task, and whatever is running behind it. */
export function stopTask(id: string): void {
  const task = tasks.get(id);
  if (!task || !live(task)) return;
  task.stop?.();
  tasks.set(id, { ...task, state: 'cancelled', finishedAt: Date.now(), log: [...task.log, { at: Date.now(), text: 'Stopped' }] });
  changed();
}

/** Take a finished task out of the tray. */
export function dismissTask(id: string): void {
  const task = tasks.get(id);
  if (!task || live(task)) return;
  tasks.delete(id);
  changed();
}

export function dismissFinished(): void {
  for (const [id, task] of tasks) if (!live(task)) tasks.delete(id);
  changed();
}

export const runningCount = (): number => [...tasks.values()].filter(live).length;

/** Test seam: forget everything. */
export function resetTasks(): void {
  tasks.clear();
  changed();
}
