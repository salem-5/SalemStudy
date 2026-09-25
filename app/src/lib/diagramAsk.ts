import { useSyncExternalStore } from 'react';
import type { DiagramCandidate } from './diagrams';
import type { Stop } from './cancel.ts';

/**
 * A quiz being written in the background stops, once it has found its diagrams, to ask which of
 * them to label. The question waits here until the dialog (DiagramAsk, mounted in the shell)
 * answers it, wherever in the app the student is by then.
 */
export type DiagramQuestion = {
  id: number;
  notebook: string;
  candidates: DiagramCandidate[];
  answer: (chosen: DiagramCandidate[]) => void;
};

let waiting: DiagramQuestion[] = [];
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((fn) => fn());
let next = 1;

export function askForDiagrams(notebook: string, candidates: DiagramCandidate[], stop?: Stop): Promise<DiagramCandidate[]> {
  return new Promise((resolve, reject) => {
    const id = next++;
    const leave = () => { waiting = waiting.filter((q) => q.id !== id); changed(); };
    // Stopping the quiz takes its question away with it.
    const off = stop?.onStop(() => { leave(); reject(new Error('stopped')); });
    waiting = [...waiting, { id, notebook, candidates, answer: (chosen) => { off?.(); leave(); resolve(chosen); } }];
    changed();
  });
}

const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

/** The question to show now: the oldest one still waiting. */
export const useDiagramQuestion = () => useSyncExternalStore(subscribe, () => waiting[0] ?? null);
