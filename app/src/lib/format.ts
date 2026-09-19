import type { Box, BoxStatus, Question } from '../types';

/** WebAssign sends "2026-09-19T23:59+0300"; Date wants "+03:00". */
export const parseDue = (s: string) => new Date(s.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));

export function relTime(d: Date): string {
  const ms = d.getTime() - Date.now();
  const abs = Math.abs(ms);
  const units: [string, number][] = [['d', 864e5], ['h', 36e5], ['m', 6e4]];
  const [u, size] = units.find(([, s]) => abs >= s) ?? ['m', 6e4];
  const n = Math.max(1, Math.floor(abs / size));
  return ms >= 0 ? `in ${n}${u}` : `${n}${u} ago`;
}

export const fmtDue = (d: Date) =>
  d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export const STATUS_LABEL: Record<BoxStatus, string> = {
  correct: 'CORRECT',
  incorrect: 'WRONG',
  partial: 'PARTIAL',
  submitted: 'GRADED',
  unanswered: 'NOT SUBMITTED',
};

export const attemptsLeft = (b: Box) =>
  b.part.maxSubmissions == null ? null : b.part.maxSubmissions - (b.part.submissions ?? 0);

/** Worst-case status of a question, for the question strip. */
export function questionStatus(q: Question): BoxStatus {
  const s = q.boxes.map((b) => b.status);
  if (!s.length) return 'unanswered';
  if (s.every((x) => x === 'correct')) return 'correct';
  if (s.some((x) => x === 'incorrect')) return 'incorrect';
  if (s.some((x) => x === 'partial' || x === 'correct')) return 'partial';
  if (s.some((x) => x === 'submitted')) return 'submitted';
  return 'unanswered';
}

export const pct = (score: number | null, total: number | null) =>
  score == null || !total ? null : Math.round((score / total) * 100);
