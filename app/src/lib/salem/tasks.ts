import { useSyncExternalStore } from 'react';
import type { ExecState } from './types';
import type { Meter } from '../meter';
import { createStop, type Stop } from '../cancel.ts';

export type TaskState = ExecState | 'queued';

export type BackgroundTask = {
  id: string;
  label: string;
  scope: string;
  state: TaskState;
  detail: string;
  log: { at: number; text: string }[];
  startedAt: number;
  finishedAt?: number;
  cost: number;
  error?: string;
  result?: string;
  stop?: () => void;
  open?: () => void;
};

export class ScopeBusy extends Error {
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

export const holderOf = (scope: string): BackgroundTask | undefined =>
  [...tasks.values()].find((t) => t.scope === scope && live(t));

export async function runInBackground<T>(
  options: {
    label: string;
    scope: string;
    stop?: () => void;
    open?: () => void;
    describe?: (result: T) => string;
  },
  work: (progress: (detail: string) => void, meter: Meter, stop: Stop) => Promise<T>,
): Promise<T> {
  const busy = holderOf(options.scope);
  if (busy) throw new ScopeBusy(busy);
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
    const log = current && current.log.at(-1)?.text !== detail
      ? [...(current?.log ?? []), { at: Date.now(), text: detail }].slice(-200)
      : current?.log ?? [];
    update({ state: 'executing', detail, log });
  };

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

export function stopTask(id: string): void {
  const task = tasks.get(id);
  if (!task || !live(task)) return;
  task.stop?.();
  tasks.set(id, { ...task, state: 'cancelled', finishedAt: Date.now(), log: [...task.log, { at: Date.now(), text: 'Stopped' }] });
  changed();
}

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

export function resetTasks(): void {
  tasks.clear();
  changed();
}
