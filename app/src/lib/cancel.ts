/**
 * Stopping a piece of work part-way.
 *
 * A deck or quiz is a dozen model calls, a few at a time. Stopping one has to
 * reach all of them: the passes not started yet must not start, the requests
 * in flight are cancelled where they are (so they stop costing anything), and
 * — above all — what was written so far is not saved as if it were the deck.
 *
 * The work checks the token at the points where it could carry on
 * (`throwIfStopped`), and anything holding something cancellable (a request
 * id) registers it with `onStop`. Pure: no Tauri here, so the tests can use it.
 */
export type Stop = {
  readonly stopped: boolean;
  /** Run `fn` when stopped (at once, if already). Returns an unsubscribe. */
  onStop: (fn: () => void) => () => void;
  /** Throw `Error('stopped')` — what the task store reads as "cancelled". */
  throwIfStopped: () => void;
};

export function createStop(): Stop & { stop: () => void } {
  let stopped = false;
  const fns = new Set<() => void>();
  return {
    get stopped() { return stopped; },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const fn of fns) { try { fn(); } catch { /* one failing must not keep the rest running */ } }
      fns.clear();
    },
    onStop(fn) {
      if (stopped) { fn(); return () => {}; }
      fns.add(fn);
      return () => { fns.delete(fn); };
    },
    throwIfStopped() {
      if (stopped) throw new Error('stopped');
    },
  };
}

/** Whether an error is a stop rather than a failure. */
export const isStop = (e: unknown) => String(e instanceof Error ? e.message : e) === 'stopped';
