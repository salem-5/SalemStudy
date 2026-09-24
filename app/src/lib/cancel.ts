export type Stop = {
  readonly stopped: boolean;
  onStop: (fn: () => void) => () => void;
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
      for (const fn of fns) { try { fn(); } catch { } }
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

export const isStop = (e: unknown) => String(e instanceof Error ? e.message : e) === 'stopped';
