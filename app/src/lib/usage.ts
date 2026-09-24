import { useCallback, useEffect, useState } from 'react';

export type Agg = {
  prompt: number;
  completion: number;
  total: number;
  hit: number;
  miss: number;
  calls: number;
};

export type QUsage = { flash: Agg; pro: Agg; attempts: number };

export type UsageRecord = {
  assignmentId: number;
  name: string;
  updated: number;
  flash: Agg;
  pro: Agg;
  questions: Record<string, QUsage>;
};

export type ModelBucket = 'flash' | 'pro';

export const emptyAgg = (): Agg => ({ prompt: 0, completion: 0, total: 0, hit: 0, miss: 0, calls: 0 });

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function addUsage(agg: Agg, usage: unknown): Agg {
  if (!usage || typeof usage !== 'object') return agg;
  const u = usage as Record<string, unknown>;
  const prompt = num(u.prompt_tokens);
  const completion = num(u.completion_tokens);
  const total = num(u.total_tokens) || prompt + completion;
  const hit = num(u.prompt_cache_hit_tokens);
  const miss = u.prompt_cache_miss_tokens != null ? num(u.prompt_cache_miss_tokens) : Math.max(0, prompt - hit);
  return {
    prompt: agg.prompt + prompt,
    completion: agg.completion + completion,
    total: agg.total + total,
    hit: agg.hit + hit,
    miss: agg.miss + miss,
    calls: agg.calls + 1,
  };
}

const RATES: Record<ModelBucket, { hit: number; miss: number; out: number }> = {
  flash: { hit: 0.003, miss: 0.15, out: 0.6 },
  pro: { hit: 0.022, miss: 0.66, out: 1.98 },
};

function isPeak(at: Date): boolean {
  const day = at.getUTCDay();
  const h = at.getUTCHours();
  return day >= 1 && day <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10));
}

export function aggCost(agg: Agg, model: ModelBucket, at = new Date()): number {
  const r = RATES[model];
  const mult = isPeak(at) ? 2 : 1;
  return ((agg.hit * r.hit + agg.miss * r.miss + agg.completion * r.out) / 1e6) * mult;
}

export const pairCost = (u: { flash: Agg; pro: Agg }, at = new Date()): number =>
  aggCost(u.flash, 'flash', at) + aggCost(u.pro, 'pro', at);

export const pairTotal = (u: { flash: Agg; pro: Agg }): number => u.flash.total + u.pro.total;
export const pairCalls = (u: { flash: Agg; pro: Agg }): number => u.flash.calls + u.pro.calls;

export const emptyPair = () => ({ flash: emptyAgg(), pro: emptyAgg() });

export const bucketOf = (model: string): ModelBucket => (model.toLowerCase().includes('pro') ? 'pro' : 'flash');

export const fmtInt = (n: number): string => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
export const fmtCost = (n: number): string => `$${n.toFixed(n < 0.01 ? 5 : 4)}`;

const KEY = 'wa.usage.v1';

function load(): Record<string, UsageRecord> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}

export function useUsage() {
  const [map, setMap] = useState<Record<string, UsageRecord>>(load);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(map));
    } catch {
    }
  }, [map]);

  const record = useCallback((assignmentId: number, name: string, qnum: number, model: string, usage: unknown) => {
    setMap((m) => {
      const id = String(assignmentId);
      const prev = m[id];
      const rec: UsageRecord = prev
        ? { ...prev, questions: { ...prev.questions } }
        : { assignmentId, name, updated: Date.now(), flash: emptyAgg(), pro: emptyAgg(), questions: {} };
      rec.name = name || rec.name;
      rec.updated = Date.now();
      const bucket = bucketOf(model);
      rec[bucket] = addUsage(rec[bucket], usage);
      const qk = String(qnum);
      const q: QUsage = rec.questions[qk] ? { ...rec.questions[qk] } : { flash: emptyAgg(), pro: emptyAgg(), attempts: 0 };
      q[bucket] = addUsage(q[bucket], usage);
      q.attempts += 1;
      rec.questions[qk] = q;
      return { ...m, [id]: rec };
    });
  }, []);

  const clear = useCallback(() => setMap({}), []);

  return { map, record, clear };
}
