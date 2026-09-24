export const GAP_IN_MATH = /\\text\{\s*_{3,}\s*\}|_{3,}/g;
export const repairTex = (tex: string) => tex.replace(GAP_IN_MATH, '\\underline{\\hspace{2.5em}}');

export const asMath = (t: string): string => (!t.includes('$') && /\\[a-zA-Z]+/.test(t) ? `$${t.trim()}$` : t);
