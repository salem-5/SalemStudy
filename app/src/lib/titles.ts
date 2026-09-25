/**
 * The rule every generated deck, quiz and note title follows, for the prompts that name them.
 * Kept in one place so the three namers ask for the same thing.
 */
export const TITLE_RULE = '2 to 4 words naming the subject matter only, like "Bone healing" or "Convergence tests". Never include file or source names, course codes, lecture or week numbers, the course name, or words like quiz, flashcards, deck or notes. No quotes, no final full stop.';

const MAX_WORDS = 6;
const NUMBERED = /^(lecture|lec|week|wk|chapter|ch|unit|part|module|session|topic|section|sec)\.?$/i;
const KIND_WORD = /^(quiz|quizzes|flashcards?|cards?|deck|notes?|summary|review|practice)$/i;
const SEPARATOR = /^[-–—:|·,/]+$/;
const isNumber = (w: string) => /^(\d+[a-z]?|[ivx]{1,5})$/i.test(w);
/** A code-like word: an acronym such as MSK or BIO101, or anything with a digit in it. */
const isCode = (w: string) => /\d/.test(w) || (/^[A-Z]{2,6}$/.test(w));

const clean = (w: string) => w.replace(/[:\-–—,.]+$/, '');

/**
 * Codes the source names use as a prefix, like MSK in "MSK Lecture 4" or "MSK - Bone healing":
 * a code-like first word followed by a label, a number, a separator or another code, or one that
 * starts two or more sources. "DNA" in "DNA replication" is the subject itself, so it stays.
 */
function prefixCodes(sourceTitles: string[]): Set<string> {
  const firsts = new Map<string, number>();
  const out = new Set<string>();
  for (const t of sourceTitles) {
    const [a, b] = t.trim().split(/[\s_]+/).map(clean);
    if (!a || !isCode(a)) continue;
    const key = a.toLowerCase();
    firsts.set(key, (firsts.get(key) ?? 0) + 1);
    if (!b || NUMBERED.test(b) || isNumber(b) || SEPARATOR.test(b) || isCode(b)) out.add(key);
  }
  for (const [k, n] of firsts) if (n > 1) out.add(k);
  return out;
}

/**
 * A title as a student would write it: the model sometimes leads with the source file's prefix
 * ("MSK Lecture 4 - Bone healing"), and that prefix then heads every deck and quiz from the same
 * course. This drops leading codes that also start a source's name, numbered labels like
 * "Lecture 4", separators, and a trailing "quiz" or "flashcards", and keeps what is left short.
 * If nothing sensible would remain, the title comes back as it was.
 */
export function tidyTitle(raw: string, sourceTitles: string[] = []): string {
  const original = raw.trim().replace(/^["'#*\s]+|["'.*\s]+$/g, '');
  const prefixes = prefixCodes(sourceTitles);
  let words = original.split(/\s+/).filter(Boolean);
  const strip = () => {
    for (;;) {
      const [w, next] = words;
      if (!w) return;
      if (SEPARATOR.test(w)) { words = words.slice(1); continue; }
      const bare = clean(w);
      if (NUMBERED.test(bare) && next && isNumber(clean(next))) { words = words.slice(2); continue; }
      if (prefixes.has(bare.toLowerCase())) { words = words.slice(1); continue; }
      if (isNumber(bare) && /\d/.test(bare)) { words = words.slice(1); continue; }
      return;
    }
  };
  strip();
  while (words.length > 1 && KIND_WORD.test(words[words.length - 1].replace(/[.:,]+$/, ''))) words = words.slice(0, -1);
  if (!words.length) return original;
  let title = words.slice(0, MAX_WORDS).join(' ').replace(/[\s:\-–—,]+$/, '');
  if (words.length > MAX_WORDS) title = title.replace(/(\s+(and|of|the|in|on|for|with|to|a|an|&))+$/i, '');
  title = title.charAt(0).toUpperCase() + title.slice(1);
  return title || original;
}

/**
 * The title pasted text gives itself: a Markdown heading on its first line, or a short first line
 * standing alone above the rest, the way a heading is usually pasted from a document.
 */
export function headingOf(text: string): string | null {
  const lines = text.split('\n').map((l) => l.trim());
  const at = lines.findIndex(Boolean);
  if (at < 0) return null;
  const first = lines[at];
  const md = first.match(/^#{1,3}\s+(.+)$/);
  const line = (md?.[1] ?? first).replace(/[*_`#]+/g, '').trim();
  if (!line || line.length > 70) return null;
  if (md) return line;
  const alone = lines[at + 1] === '' && lines.slice(at + 2).some(Boolean);
  const titleLike = line.split(/\s+/).length <= 8 && !/[.,;:!?]$/.test(line);
  return alone && titleLike ? line : null;
}
