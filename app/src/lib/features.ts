import { useSyncExternalStore } from 'react';

/**
 * Optional parts of the app. The Assignment Solver (WebAssign) is off for new
 * installs; someone who has already used it keeps it on.
 */

const KEY = 'wa.feature.solver';
/** Keys only the solver writes: their presence means it has been used here. */
const SOLVER_TRACES = ['wa.selected', 'wa.usage.v1', 'wa.drafts.v1', 'wa.section'];
const listeners = new Set<() => void>();

export function solverEnabled(): boolean {
  try {
    const v = localStorage.getItem(KEY);
    if (v === '1' || v === '0') return v === '1';
    const used = SOLVER_TRACES.some((k) => localStorage.getItem(k) !== null);
    localStorage.setItem(KEY, used ? '1' : '0');
    return used;
  } catch { return false; }
}

export function setSolverEnabled(on: boolean) {
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
  listeners.forEach((l) => l());
}

/** Re-read `keys` when the window or a tab changes them (lib/prefSync). */
const onShared = (keys: string[], fn: () => void) => {
  if (typeof window === 'undefined') return;
  window.addEventListener('wa:prefs', (e) => {
    if (keys.includes((e as CustomEvent<{ key: string }>).detail?.key)) fn();
  });
};
onShared([KEY], () => listeners.forEach((l) => l()));

export const useSolverEnabled = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, solverEnabled);
