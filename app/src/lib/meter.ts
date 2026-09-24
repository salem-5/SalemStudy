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

export const charge = (meter: Meter | undefined, reply: { cost?: unknown } | null | undefined) => {
  if (meter && reply && typeof reply.cost === 'number') meter.add(reply.cost);
};

export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return '';
  if (usd <= 0) return '$0';
  if (usd < 0.0001) return '<$0.0001';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

const KEY = 'wa.cost';

export function rememberCost(kind: 'note' | 'deck' | 'quiz', id: number, usd: number): void {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, number>;
    all[`${kind}:${id}`] = usd;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { }
}

export function recalledCost(kind: 'note' | 'deck' | 'quiz', id: number): number | null {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, number>;
    return typeof all[`${kind}:${id}`] === 'number' ? all[`${kind}:${id}`] : null;
  } catch { return null; }
}
