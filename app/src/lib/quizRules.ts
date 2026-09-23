/**
 * How a quiz answer is marked, and what makes a hint worth showing.
 *
 * These are the rules a student's score depends on, so they live on their own:
 * no model, no Tauri, no imports beyond the types. `lib/studyGen` and the quiz
 * player both use them, and `studyGen.test.ts` tests them directly.
 */

import type { QuestionType, QuizQuestion } from '../study/api';

/**
 * A hint that names the answer is worse than no hint: the student stops
 * thinking and learns nothing. Anything that gives it away is dropped rather
 * than shown.
 */
export function usableHint(hint: string, q: { type: QuestionType; answer: string | number; answers?: number[]; choices?: string[]; accept?: string[] }): string {
  const text = hint.trim();
  if (!text) return '';
  const lower = text.toLowerCase();
  const gives: string[] = [];
  if (q.type === 'mcq') gives.push(String(q.choices?.[Number(q.answer)] ?? ''));
  if (q.type === 'multi') gives.push(...(q.answers ?? []).map((i) => String(q.choices?.[i] ?? '')));
  if (q.type === 'blank') gives.push(String(q.answer), ...(q.accept ?? []));
  if (q.type === 'tf') {
    // "the statement is true" is the whole answer for a true/false question.
    if (/\bis (true|false)\b|\banswer is\b/i.test(lower)) return '';
  }
  if (q.type === 'numeric') gives.push(String(q.answer));
  for (const give of gives) {
    const needle = give.trim().toLowerCase();
    if (needle.length >= 3 && lower.includes(needle)) return '';
  }
  if (/\boption [a-f1-6]\b|\bchoice \d\b|\bthe answer is\b/i.test(lower)) return '';
  return text;
}

export const defaultTolerance = (n: number) => Math.max(Math.abs(n) * 0.01, 1e-6);

/** "3/2", "-0.5", "1.2e3", "2 m/s" → number. */
export function parseNumber(s: string): number | null {
  const t = s.trim().replace(/,/g, '').replace(/−/g, '-');
  const frac = t.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/);
  if (frac) {
    const v = Number(frac[1]) / Number(frac[2]);
    return Number.isFinite(v) ? v : null;
  }
  const m = t.match(/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i);
  if (!m) return null;
  const v = Number(m[0]);
  return Number.isFinite(v) ? v : null;
}

/** Does the check script's last printed line agree with the stated answer? */
export function checkAgrees(q: QuizQuestion, stdout: string): boolean {
  const last = stdout.trim().split('\n').pop()?.trim() ?? '';
  if (!last) return false;
  if (q.type === 'mcq') return Number.parseInt(last, 10) === q.answer;
  if (q.type === 'multi') return sameSet(picked(last.replace(/[[\]\s]/g, '')), q.answers ?? []);
  if (q.type === 'tf') return last.toLowerCase() === String(q.answer);
  if (q.type === 'blank') return fillsTheGap(q, last);
  if (q.type === 'numeric') {
    const v = parseNumber(last);
    return v !== null && Math.abs(v - Number(q.answer)) <= Math.max(q.tolerance ?? 0, defaultTolerance(Number(q.answer)));
  }
  return true;
}

/** Grade anything except short answers locally. */
export function gradeLocal(q: QuizQuestion, given: string): boolean {
  if (q.type === 'mcq') return Number(given) === q.answer;
  if (q.type === 'tf') return given === q.answer;
  if (q.type === 'multi') return sameSet(picked(given), q.answers ?? []);
  if (q.type === 'blank') return fillsTheGap(q, given);
  if (q.type === 'numeric') {
    const v = parseNumber(given);
    // The question's own tolerance wins. Widening it to the 1% default would
    // mark an answer right that the question says is wrong.
    const tolerance = q.tolerance && q.tolerance > 0 ? q.tolerance : defaultTolerance(Number(q.answer));
    return v !== null && Math.abs(v - Number(q.answer)) <= tolerance;
  }
  return false;
}

/** "0,2" → [0, 2]. The stored form of a multi-select answer. */
export const picked = (given: string): number[] =>
  [...new Set(
    given
      .split(',')
      .map((part) => part.trim())
      // An empty answer means nothing was chosen. Without this, Number('')
      // is 0 and an unanswered question looks like the first choice.
      .filter((part) => part !== '')
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 0),
  )].sort((a, b) => a - b);

export const unpick = (indexes: number[]): string => [...indexes].sort((a, b) => a - b).join(',');

const sameSet = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === [...b].sort((x, y) => x - y)[i]);

/**
 * Fill-in-the-blank marking. A student typing "mitochondria" when the source
 * said "Mitochondrion" has the right idea, so case, surrounding punctuation,
 * articles and spacing are ignored, and the question may list other forms it
 * accepts. Anything beyond that is a different answer, not a near miss.
 */
export function fillsTheGap(q: { answer: string | number; accept?: string[] }, given: string): boolean {
  const norm = (text: string) =>
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/^(?:the|a|an)\s+/, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const mine = norm(given);
  if (!mine) return false;
  return [String(q.answer), ...(q.accept ?? [])].some((candidate) => {
    const theirs = norm(candidate);
    if (!theirs) return false;
    if (mine === theirs) return true;
    // Singular and plural are the same word for marking. Both sides are
    // reduced the same way, or "ribosomes" would never match "ribosome".
    const stem = (word: string) => word.replace(/(?:es|s)$/, '').replace(/e$/, '');
    return stem(mine) === stem(theirs);
  });
}

/**
 * Move the right answer somewhere else.
 *
 * Models put the correct choice first far more often than one time in four,
 * and a student who notices that stops reading the other options. Shuffling
 * here — rather than asking the model to do it — means it cannot fail to.
 */
export function shuffleChoices(q: QuizQuestion, random: () => number = Math.random): QuizQuestion {
  const choices = q.choices;
  if ((q.type !== 'mcq' && q.type !== 'multi') || !choices || choices.length < 2) return q;
  const order = choices.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  // order[newIndex] = oldIndex, so the answer keys move with the text.
  const moved = order.map((old) => choices[old]);
  const place = (old: number) => order.indexOf(old);
  if (q.type === 'multi') {
    const answers = (q.answers ?? []).map(place).sort((a, b) => a - b);
    return { ...q, choices: moved, answers, answer: answers.join(',') };
  }
  return { ...q, choices: moved, answer: place(Number(q.answer)) };
}
