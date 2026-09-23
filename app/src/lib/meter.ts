/**
 * What a piece of work cost.
 *
 * Every model call comes back with its price (worked out on the Rust side,
 * where the rates live, and logged there for the Settings totals). A meter
 * is how one piece of work — a deck, a quiz, a chat reply, a note — adds up
 * its own calls so the student can see what it cost, live while it runs.
 *
 * It is passed down explicitly rather than kept in some ambient "current
 * job": a deck, a quiz and two chats can all be running at once, and each
 * call has to land on the right one.
 */
export type Meter = {
  add: (usd: number) => void;
  readonly total: number;
};

export function createMeter(onChange?: (total: number) => void): Meter {
  let total = 0;
  return {
    add(usd) {
      if (!Number.isFinite(usd) || usd <= 0) return;
      total += usd;
      onChange?.(total);
    },
    get total() { return total; },
  };
}

/** Report a reply's cost to a meter, if the call had one. */
export const charge = (meter: Meter | undefined, reply: { cost?: unknown } | null | undefined) => {
  if (meter && reply && typeof reply.cost === 'number') meter.add(reply.cost);
};

/**
 * A price the way a student reads it. Most of this work costs fractions of a
 * cent, so small amounts keep enough digits to mean something instead of
 * all rounding to "$0.00".
 */
export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return '';
  if (usd <= 0) return '$0';
  if (usd < 0.0001) return '<$0.0001';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Where a finished piece of work keeps its price, so it is still there when
 * the student comes back to it: a note's footer, a deck's page. Chat replies
 * keep theirs on the message itself.
 */
const KEY = 'wa.cost';

export function rememberCost(kind: 'note' | 'deck' | 'quiz', id: number, usd: number): void {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, number>;
    all[`${kind}:${id}`] = usd;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* a missing price is not worth an error */ }
}

export function recalledCost(kind: 'note' | 'deck' | 'quiz', id: number): number | null {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, number>;
    return typeof all[`${kind}:${id}`] === 'number' ? all[`${kind}:${id}`] : null;
  } catch { return null; }
}
