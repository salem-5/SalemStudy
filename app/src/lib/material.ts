/**
 * Gathering the material a deck, quiz or set of notes is written from.
 *
 * Every page of every chosen source, in reading order — not a sample. A deck
 * that is meant to follow the lecture page by page cannot be built from a
 * handful of excerpts picked for relevance; the pages it never saw are the
 * pages it will have no cards for.
 */
import { studyApi, type Source, type SourceHit } from '../study/api';
import { applyOrder } from './deckPlan';

/** Every page of each source, in the order given. */
export async function wholeSources(sources: Pick<Source, 'id' | 'title' | 'kind'>[]): Promise<SourceHit[]> {
  const out: SourceHit[] = [];
  for (const source of sources) {
    const units = await studyApi.sourceUnits(source.id).catch(() => []);
    for (const unit of [...units].sort((a, b) => a.ord - b.ord)) {
      out.push({
        chunkId: -1,
        sourceId: source.id,
        sourceTitle: source.title,
        kind: source.kind,
        unitFrom: unit.ord,
        unitTo: unit.ord,
        label: unit.label,
        // Empty pages stay: a title slide is still a page, and the walk
        // decides it needs no cards rather than losing track of where it is.
        text: unit.text.trim(),
        score: 0,
      });
    }
  }
  return out;
}

/** A notebook's ready sources, in reading order, then every page of them. */
export async function notebookMaterial(notebookId: number, order?: number[]): Promise<SourceHit[]> {
  const ready = (await studyApi.sources(notebookId)).filter((s) => s.status === 'ready');
  return wholeSources(applyOrder(ready, order));
}
