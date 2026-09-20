import type { Box, Question } from '../types';
import { boxContexts } from './ai';

// ---------------------------------------------------------------------------
// WebAssign prints part of the answer itself: the box sits inside brackets it
// already draws, after an "=", or in front of a unit. Models keep repeating
// those, and a repeated bracket is graded wrong. The prompt asks them not to;
// this strips them anyway, because a rule the model can ignore is not a rule.
// ---------------------------------------------------------------------------

export type BoxContext = { before: string; after: string };

/** Bracket families, so a printed `⟨` also catches an answer written `<…>`. */
const FAMILIES: { opens: string[]; closes: string[] }[] = [
  { opens: ['('], closes: [')'] },
  { opens: ['['], closes: [']'] },
  { opens: ['{'], closes: ['}'] },
  { opens: ['<', '⟨', '〈'], closes: ['>', '⟩', '〉'] },
  { opens: ['|'], closes: ['|'] },
  { opens: ['‖'], closes: ['‖'] },
];

const familyOf = (ch: string) => FAMILIES.find((f) => f.opens.includes(ch) || f.closes.includes(ch));

/** The bracket pair the question itself draws around a box, if any. */
export function printedBrackets(ctx: BoxContext | undefined): { opens: string[]; closes: string[] } | null {
  if (!ctx) return null;
  const open = ctx.before.trimEnd().slice(-1);
  const close = ctx.after.trimStart().slice(0, 1);
  const family = familyOf(open);
  if (!family || !family.opens.includes(open)) return null;
  return family.closes.includes(close) ? family : null;
}

/** True when the brackets inside `s` never close more than they opened. */
function balancedInside(s: string, opens: string[], closes: string[]): boolean {
  // A bar is its own partner, so "balance" just means none is left over.
  if (opens.some((o) => closes.includes(o))) return !opens.some((o) => s.includes(o));
  let depth = 0;
  for (const ch of s) {
    if (opens.includes(ch)) depth++;
    else if (closes.includes(ch)) { depth--; if (depth < 0) return false; }
  }
  return depth === 0;
}

/** Peel bracket layers the question already prints around the box. */
function stripBrackets(value: string, family: { opens: string[]; closes: string[] }): string {
  let s = value.trim();
  for (;;) {
    const open = s.slice(0, 1);
    const close = s.slice(-1);
    if (s.length < 2 || !family.opens.includes(open) || !family.closes.includes(close)) return s;
    const inner = s.slice(1, -1);
    if (!inner.trim() || !balancedInside(inner, family.opens, family.closes)) return s;
    s = inner.trim();
  }
}

const UNITS = ['°', '%', '$', '£', '€'];

/**
 * Clean one answer against what the question prints around its box. Returns
 * the value unchanged when there is nothing to remove.
 */
export function fixAnswerText(value: string, ctx: BoxContext | undefined): { value: string; notes: string[] } {
  const notes: string[] = [];
  let s = value.trim();
  if (!s || !ctx) return { value, notes };

  const family = printedBrackets(ctx);
  if (family) {
    const stripped = stripBrackets(s, family);
    if (stripped !== s) {
      notes.push(`dropped the ${family.opens[0]}${family.closes[0]} the question already prints`);
      s = stripped;
    }
  }

  // "u . v = [1]": the box takes the right-hand side only. A comparison
  // operator (<=, >=, !=, ==) is part of the answer, not a restated equation.
  if (/[=:]\s*$/.test(ctx.before)) {
    const at = s.search(/(?<![<>!=])=(?!=)[^=]*$/);
    const rhs = at >= 0 ? s.slice(at + 1).trim() : '';
    if (at >= 0 && rhs) {
      notes.push('dropped the "=" the question already prints');
      s = rhs;
    }
  }

  // "[1] °" or "$ [1]": the symbol is printed, not typed.
  const trailing = UNITS.find((u) => ctx.after.trimStart().startsWith(u));
  if (trailing && s.endsWith(trailing)) {
    notes.push(`dropped the trailing "${trailing}" the question already prints`);
    s = s.slice(0, -trailing.length).trim();
  }
  const leading = UNITS.find((u) => ctx.before.trimEnd().endsWith(u));
  if (leading && s.startsWith(leading)) {
    notes.push(`dropped the leading "${leading}" the question already prints`);
    s = s.slice(leading.length).trim();
  }

  return { value: s || value, notes };
}

/** Whether a box's answer is free text the fixes above apply to. */
const typed = (b: Box) => b.kind === 'math' || b.kind === 'text' || b.kind === 'unsupported';

/**
 * Apply the fixes to a whole set of proposed answers, reporting each change so
 * the student sees what was corrected before it is submitted.
 */
export function fixAnswers(
  q: Question,
  answers: Record<string, unknown>,
): { answers: Record<string, unknown>; notes: string[] } {
  const ctx = boxContexts(q);
  const out: Record<string, unknown> = { ...answers };
  const notes: string[] = [];
  for (const [key, value] of Object.entries(answers)) {
    const box = q.boxes[Number(key) - 1];
    if (!box || !typed(box) || typeof value !== 'string') continue;
    const fixed = fixAnswerText(value, ctx.get(box.index));
    if (fixed.value === value) continue;
    out[key] = fixed.value;
    notes.push(`[${box.index}] ${fixed.notes.join('; ')} — "${value}" → "${fixed.value}"`);
  }
  return { answers: out, notes };
}
