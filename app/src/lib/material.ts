import { studyApi, type Source, type SourceHit } from '../study/api';
import { applyOrder } from './deckPlan';

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
        text: unit.text.trim(),
        score: 0,
      });
    }
  }
  return out;
}

export async function notebookMaterial(notebookId: number, order?: number[]): Promise<SourceHit[]> {
  const ready = (await studyApi.sources(notebookId)).filter((s) => s.status === 'ready');
  return wholeSources(applyOrder(ready, order));
}
