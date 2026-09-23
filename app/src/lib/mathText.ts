/**
 * Small repairs to maths as models write it, before KaTeX sees it. Pure, so
 * it is tested on its own (`mathText.test.ts`).
 */

/**
 * A fill-the-gap blank written inside the maths — `\frac{a\cdot b}{_____}`,
 * `\text{_____}` — is a gap, not five subscripts. KaTeX reads underscores as
 * subscripts and fails on the lot, which is the red error text. Drawn as a
 * line to write on instead.
 */
export const GAP_IN_MATH = /\\text\{\s*_{3,}\s*\}|_{3,}/g;
export const repairTex = (tex: string) => tex.replace(GAP_IN_MATH, '\\underline{\\hspace{2.5em}}');

/**
 * An answer or a choice the model wrote as bare LaTeX ("-\\mathbf{b}") with
 * no dollars round it, as maths, so it is typeset rather than shown raw.
 */
export const asMath = (t: string): string => (!t.includes('$') && /\\[a-zA-Z]+/.test(t) ? `$${t.trim()}$` : t);

