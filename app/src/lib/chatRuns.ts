import { useSyncExternalStore } from 'react';
import type { Citation } from './retrieval';
import type { ExecState } from './salem/types';
import type { AppAction, PythonRun, Step } from '../study/api';

export type ChatRun = {
  conversationId: number;
  question: string;
  steps: Step[];
  runs: PythonRun[];
  actions: AppAction[];
  citations: Citation[];
  state: ExecState;
  detail: string;
  startedAt: number;
  stopped: boolean;
  abort: (() => void) | null;
  cost: number;
  version: number;
};

const runs = new Map<number, ChatRun>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<number, ChatRun> = new Map();

const changed = () => {
  snapshot = new Map(runs);
  listeners.forEach((l) => l());
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};

export function useChatRun(conversationId: number | null): ChatRun | null {
  const all = useSyncExternalStore(subscribe, () => snapshot);
  return conversationId === null ? null : all.get(conversationId) ?? null;
}

export function useChatRunCount(): number {
  return useSyncExternalStore(subscribe, () => snapshot).size;
}

export const chatRunning = (conversationId: number): boolean => runs.has(conversationId);

export function beginRun(conversationId: number, question: string): ChatRun {
  const run: ChatRun = {
    conversationId,
    question,
    steps: [],
    runs: [],
    actions: [],
    citations: [],
    state: 'planning',
    detail: '',
    startedAt: Date.now(),
    stopped: false,
    abort: null,
    cost: 0,
    version: 0,
  };
  runs.set(conversationId, run);
  changed();
  return run;
}

export function updateRun(conversationId: number, patch: Partial<ChatRun>): void {
  const current = runs.get(conversationId);
  if (!current) return;
  runs.set(conversationId, { ...current, ...patch, version: current.version + 1 });
  changed();
}

export function endRun(conversationId: number): void {
  if (!runs.delete(conversationId)) return;
  changed();
}

export function stopRun(conversationId: number): void {
  const current = runs.get(conversationId);
  if (!current) return;
  current.abort?.();
  runs.set(conversationId, { ...current, stopped: true, version: current.version + 1 });
  changed();
}

export const isStopped = (conversationId: number): boolean => runs.get(conversationId)?.stopped ?? false;

export const currentRun = (conversationId: number): ChatRun | undefined => runs.get(conversationId);

export function resetChatRuns(): void {
  runs.clear();
  changed();
}
