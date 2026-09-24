import { studyApi, type ChatMessage, type Source, type SourceHit } from '../study/api';

export type Citation = { n: number; sourceId: number; title: string; label: string; unit: number };

const BROAD = /\b(summar|overview|everything|all (the|of)|main (ideas|topics|points)|key (ideas|points|concepts)|what (do|should) i (need|know)|exam|midterm|final|review sheet|cover(ed|s)?)\b/i;

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);

export async function retrieve(sources: Source[], history: ChatMessage[], question: string): Promise<{ context: string; citations: Citation[] }> {
  const ready = sources.filter((s) => s.status === 'ready');
  if (!ready.length) return { context: '', citations: [] };
  const ids = ready.map((s) => s.id);
  const prevUser = [...history].reverse().find((m) => m.role === 'user' && m.content !== question)?.content ?? '';
  const query = `${question} ${question.length < 80 ? prevUser : ''}`;

  let hits: SourceHit[];
  if (BROAD.test(question)) {
    hits = await studyApi.sampleSources(ids, 24_000);
  } else {
    hits = await studyApi.searchSources(ids, query, 8);
    const covered = new Set(hits.map((h) => h.sourceId));
    for (const s of ready) {
      if (covered.has(s.id) || hits.length >= 14) continue;
      const best = await studyApi.searchSources([s.id], query, 1);
      if (best[0]) hits.push(best[0]);
    }
    if (!hits.length) hits = await studyApi.sampleSources(ids, 10_000);
  }

  const citations: Citation[] = hits.map((h, i) => ({ n: i + 1, sourceId: h.sourceId, title: h.sourceTitle, label: h.label, unit: h.unitFrom }));
  const inventory = ready.map((s) => `- ${s.title} (${s.kind}${s.unitCount ? `, ${s.unitCount} ${s.kind === 'pdf' ? 'pages' : s.kind === 'slides' ? 'slides' : 'parts'}` : ''})`).join('\n');
  const excerpts = hits.map((h, i) => `[${i + 1}] ${h.sourceTitle} - ${h.label}\n${clip(h.text, 2500)}`).join('\n\n');
  const context = `## The notebook's sources
The student has these sources in this notebook:
${inventory}

Excerpts retrieved for this question:

${excerpts}

## Using the sources
- Base course-specific facts, definitions, notation and examples on the excerpts, and cite them with their number in square brackets right after the sentence they support, e.g. "… [2]". Cite several when several agree; never invent a number.
- If two excerpts disagree, say so and cite both.
- If the excerpts do not cover the question, say that the notebook's sources do not cover it, then answer from general knowledge and mark that part as such.`;
  return { context, citations };
}
