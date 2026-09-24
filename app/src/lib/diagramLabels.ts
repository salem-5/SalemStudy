import type { DiagramLabel } from '../study/api';

export type Line = { t: string; b: [number, number, number, number] };
export type Found = { name: string; where: number; lines: Line[] };
export type Picked = { name?: unknown; use?: unknown; prompt?: unknown; topic?: unknown; labels?: { lines?: unknown; answer?: unknown; accept?: unknown }[] };

export function unionBox(lines: Line[], pad = 0.006): [number, number, number, number] {
  const x0 = Math.min(...lines.map((l) => l.b[0])) - pad;
  const y0 = Math.min(...lines.map((l) => l.b[1])) - pad;
  const x1 = Math.max(...lines.map((l) => l.b[2])) + pad;
  const y1 = Math.max(...lines.map((l) => l.b[3])) + pad;
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  return [clamp(x0), clamp(y0), clamp(x1), clamp(y1)];
}

export function toLabels(f: Found, picked: Picked): DiagramLabel[] {
  const used = new Set<number>();
  const labels: DiagramLabel[] = [];
  for (const l of picked.labels ?? []) {
    const idx = (Array.isArray(l.lines) ? l.lines : [])
      .map(Number)
      .filter((i) => Number.isInteger(i) && i >= 0 && i < f.lines.length && !used.has(i));
    const answer = String(l.answer ?? '').replace(/^[\s\-–•·*>]+|[\s\-–•·*:<]+$/g, '').trim();
    if (!idx.length || !answer) continue;
    idx.forEach((i) => used.add(i));
    const accept = Array.isArray(l.accept) ? l.accept.map((a) => String(a).trim()).filter(Boolean).slice(0, 6) : [];
    labels.push({ box: unionBox(idx.map((i) => f.lines[i])), answer, ...(accept.length ? { accept } : {}) });
  }
  return labels;
}

const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function repeats(labels: DiagramLabel[], taken: DiagramLabel[][]): boolean {
  const mine = new Set(labels.map((l) => plain(l.answer)));
  return taken.some((other) => {
    const theirs = new Set(other.map((l) => plain(l.answer)));
    const shared = [...mine].filter((a) => theirs.has(a)).length;
    return shared / Math.min(mine.size, theirs.size) >= 0.6;
  });
}

const PICTURE_NOTE = /\n*\[(?:Figures on this page|Picture on this slide)\][\s\S]*$/;

export const withoutPictures = (text: string) => text.replace(PICTURE_NOTE, '');

const STOP = new Set(['the', 'of', 'and', 'a', 'an', 'at', 'in', 'on', 'to', 'for', 'with', 'by', 'from', 'or', 'its', 'into', 'is', 'are']);

const stem = (w: string) => {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(ch|sh|x|z|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
};

export const words = (text: string): string[] => text
  .toLowerCase()
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/ae/g, 'e').replace(/oe/g, 'e')
  .replace(/[^a-z0-9]+/g, ' ')
  .split(' ')
  .filter((w) => w && !/^\d+$/.test(w))
  .map(stem);

export type Taught = { words: string[]; seen: Set<string> };

const BREAK = '#';

export function taughtIn(texts: string[]): Taught {
  const all = texts
    .map(withoutPictures)
    .flatMap((t) => t.split(/[.!?;]+(?=\s|$)/).flatMap((sentence) => [...words(sentence), BREAK]));
  return { words: all, seen: new Set(all) };
}

function mentions(term: string, taught: Taught): boolean {
  const key = words(term).filter((w) => !STOP.has(w));
  if (!key.length) return false;
  if (key.length === 1) return taught.seen.has(key[0]);
  const need = key.length >= 3 ? Math.ceil(key.length * (2 / 3)) : key.length;
  if (key.filter((w) => taught.seen.has(w)).length < need) return false;
  const want = new Set(key);
  const at = taught.words;
  for (let i = 0; i < at.length; i++) {
    if (!want.has(at[i])) continue;
    const found = new Set<string>();
    for (let j = i; j < Math.min(at.length, i + 10) && at[j] !== BREAK; j++) if (want.has(at[j])) found.add(at[j]);
    if (found.size >= need) return true;
  }
  return false;
}

export const isTaught = (label: Pick<DiagramLabel, 'answer' | 'accept'>, taught: Taught): boolean =>
  [label.answer, ...(label.accept ?? [])].some((term) => mentions(term, taught));

export type Page = { sourceId: number; unit: number; text: string };

export function echoes(lines: Line[], pageText: string): boolean {
  const page = words(withoutPictures(pageText)).filter((w) => !STOP.has(w));
  if (!lines.length || !page.length) return false;
  const onPicture = new Set(lines.flatMap((l) => words(l.t)));
  return page.filter((w) => onPicture.has(w)).length / page.length >= 0.6;
}

const NEARBY = 6;
const ENOUGH_WORDS = 40;

export function evidenceFor(pages: Page[], sourceId: number, unit: number, lines: Line[], extra: string[] = []): Taught {
  const own = pages.find((p) => p.sourceId === sourceId && p.unit === unit);
  const skip = own && echoes(lines, own.text) ? own : null;
  const near = pages.filter((p) => p !== skip && p.sourceId === sourceId && Math.abs(p.unit - unit) <= NEARBY);
  const said = near.flatMap((p) => words(withoutPictures(p.text))).filter((w) => !STOP.has(w)).length;
  const pool = said >= ENOUGH_WORDS ? near : pages.filter((p) => p !== skip);
  return taughtIn([...pool.map((p) => p.text), ...extra]);
}
