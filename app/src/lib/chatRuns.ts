/**
 * Answers being written right now, for the whole app to see.
 *
 * A reply used to live inside the chat view that started it: navigating away
 * cancelled the stream and threw the half-written answer away, so the only
 * safe thing to do was sit and wait for it. A turn is work the student
 * started, not a property of a mounted component — so it lives here instead.
 *
 * Leaving the chat now leaves the answer running. Coming back picks it up
 * mid-sentence, and the sidebar says something is happening while you are
 * somewhere else.
 */
import { useSyncExternalStore } from 'react';
import type { Citation } from './retrieval';
import type { ExecState } from './salem/types';
import type { AppAction, PythonRun, Step } from '../study/api';

export type ChatRun = {
  conversationId: number;
  /** What was asked, so a view that arrives late can say what it is working on. */
  question: string;
  steps: Step[];
  runs: PythonRun[];
  actions: AppAction[];
  citations: Citation[];
  state: ExecState;
  detail: string;
  startedAt: number;
  /** Set when the student asks for it to stop; the turn checks this. */
  stopped: boolean;
  /** How to abort the request in flight, if there is one. The two paths a
   *  turn can take are cancelled differently, so the turn supplies this
   *  rather than the store guessing from an id. */
  abort: (() => void) | null;
  /** What the reply has cost so far, in USD. */
  cost: number;
  /** Bumped whenever the run changes, so React sees a new object. */
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

/** The answer being written in this chat, if one is. */
export function useChatRun(conversationId: number | null): ChatRun | null {
  const all = useSyncExternalStore(subscribe, () => snapshot);
  return conversationId === null ? null : all.get(conversationId) ?? null;
}

/** How many answers are being written anywhere. For the sidebar. */
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

/** Fold in what the turn has produced so far. */
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

/**
 * Ask a turn to stop.
 *
 * The flag is what the turn itself checks at every step; `abort` cuts the
 * request already in flight, so Stop is felt now rather than at the end of
 * whatever sentence was being written.
 */
export function stopRun(conversationId: number): void {
  const current = runs.get(conversationId);
  if (!current) return;
  current.abort?.();
  runs.set(conversationId, { ...current, stopped: true, version: current.version + 1 });
  changed();
}

export const isStopped = (conversationId: number): boolean => runs.get(conversationId)?.stopped ?? false;

/** The run as it stands right now, outside React. */
export const currentRun = (conversationId: number): ChatRun | undefined => runs.get(conversationId);

/** Test seam. */
export function resetChatRuns(): void {
  runs.clear();
  changed();
}
