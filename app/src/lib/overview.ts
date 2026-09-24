import { generateText } from './salem/generate';
import { studyApi, type NotebookSummary, type Source } from '../study/api';

const SYSTEM = `You write the overview page of a student's study notebook: what it covers, at a glance.

Format (Markdown):
- One sentence saying what the notebook is about.
- Then 2–6 "###" headings for the main areas, each with 2–6 short bullets naming the specific topics (3–8 words each; key formulas may appear in $...$).
- No explanations, no advice, no preamble. At most ~30 bullets in total.`;

export function overviewStale(nb: NotebookSummary, sources: Source[]): boolean {
  const ready = sources.filter((s) => s.status === 'ready');
  if (!ready.length) return false;
  return !nb.overview || ready.some((s) => s.createdAt > nb.overviewAt);
}

const running = new Set<number>();

export async function writeOverview(nb: NotebookSummary, subject: string): Promise<string> {
  if (running.has(nb.id)) throw new Error('Already writing the overview.');
  running.add(nb.id);
  try {
    const [sources, notes, decks] = await Promise.all([studyApi.sources(nb.id), studyApi.notes(nb.id), studyApi.decks(nb.id)]);
    const ready = sources.filter((s) => s.status === 'ready');
    const hits = ready.length ? await studyApi.sampleSources(ready.map((s) => s.id), 30_000) : [];
    const material = hits.map((h) => `<excerpt source="${h.sourceTitle}" where="${h.label}">\n${h.text}\n</excerpt>`).join('\n\n');
    const user = `Course: ${subject}\nNotebook: ${nb.name}${nb.description ? ` — ${nb.description}` : ''}
Sources: ${ready.map((s) => s.title).join('; ') || 'none'}
Notes: ${notes.map((n) => n.title).join('; ') || 'none'}
Flashcard decks: ${decks.map((d) => d.title).join('; ') || 'none'}

${material || 'There are no source excerpts; base the overview on the titles above.'}`;
    const text = await generateText({
      feature: 'overview',
      system: SYSTEM,
      instruction: user,
    });
    await studyApi.setOverview(nb.id, text);
    return text;
  } finally {
    running.delete(nb.id);
  }
}
