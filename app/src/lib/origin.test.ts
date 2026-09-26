import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { asOrigin, citeCounts, citedOrigin, coverage, originOf, pagesOf, ranges, readOf, refsOf } from './origin.ts';
import type { SourceHit } from '../study/api';

const hit = (sourceId: number, from: number, to = from): SourceHit => ({
  chunkId: -1, sourceId, sourceTitle: `Lecture ${sourceId}`, kind: 'pdf', unitFrom: from, unitTo: to, label: `Page ${from + 1}`, text: 'x', score: 0,
});

describe('the pages a request read', () => {
  it('opens a chunk that spans pages into each page', () => {
    assert.deepEqual(pagesOf([hit(1, 2, 4)]).map((p) => p.unit), [2, 3, 4]);
  });

  it('folds pages into runs', () => {
    assert.deepEqual(ranges([5, 0, 1, 2, 9, 1, 4]), [[0, 2], [4, 5], [9, 9]]);
    assert.deepEqual(ranges([]), []);
  });
});

describe('what a deck, quiz or note was made from', () => {
  it('keeps each source with the pages that were read, in the order they were picked', () => {
    const src = { kind: 'sources' as const, hits: [hit(2, 0), hit(1, 0), hit(1, 1)], focus: '  only chapter 2 ' };
    const origin = originOf(src, { pages: pagesOf([hit(1, 0), hit(1, 1), hit(2, 0)]), notes: [] });
    assert.deepEqual(origin, {
      kind: 'sources',
      sources: [
        { sourceId: 2, title: 'Lecture 2', kind: 'pdf', units: [[0, 0]] },
        { sourceId: 1, title: 'Lecture 1', kind: 'pdf', units: [[0, 1]] },
      ],
      notes: [],
      focus: 'only chapter 2',
    });
  });

  it('leaves out a source that was picked but never read', () => {
    const src = { kind: 'sources' as const, hits: [hit(1, 0), hit(2, 0)], focus: '' };
    const origin = originOf(src, { pages: pagesOf([hit(1, 0)]), notes: [] });
    assert.equal(origin.kind === 'sources' && origin.sources.map((s) => s.sourceId).join(), '1');
  });

  it('adds pages the items cite past the ones read, and notes they cite', () => {
    const src = { kind: 'sources' as const, hits: [hit(1, 0), hit(1, 7)], focus: '' };
    const origin = originOf(src, { pages: pagesOf([hit(1, 0)]), notes: [] }, [
      [{ sourceId: 1, title: 'Lecture 1', label: 'Page 8', unit: 7 }],
      [{ sourceId: -4, title: 'My summary', label: 'your notes', unit: 0 }],
      undefined,
    ]);
    assert.deepEqual(origin.kind === 'sources' && origin.sources[0].units, [[0, 0], [7, 7]]);
    assert.deepEqual(origin.kind === 'sources' && origin.notes, [{ id: 4, title: 'My summary' }]);
  });

  it('files note sections read page by page under notes, not sources', () => {
    const src = { kind: 'sources' as const, hits: [hit(1, 0)], notes: [{ id: 6, title: 'Limits', content: 'x' }], focus: '' };
    const origin = originOf(src, { pages: [...pagesOf([hit(1, 0)]), { sourceId: -6, title: 'Limits', kind: 'text', unit: 0 }], notes: [] });
    assert.deepEqual(origin.kind === 'sources' && origin.sources.map((s) => s.sourceId), [1]);
    assert.deepEqual(origin.kind === 'sources' && origin.notes, [{ id: 6, title: 'Limits' }]);
  });

  it('keeps the notes a request was given', () => {
    const src = { kind: 'sources' as const, hits: [], notes: [{ id: 3, title: 'Limits', content: 'long text' }], focus: '' };
    assert.deepEqual(readOf(src).notes, [{ id: 3, title: 'Limits' }]);
    const origin = originOf(src, readOf(src));
    assert.deepEqual(origin.kind === 'sources' && origin.notes, [{ id: 3, title: 'Limits' }]);
  });

  it('names the chat, topic or mistakes it came from', () => {
    const messages = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'event', content: 'c' }];
    assert.deepEqual(originOf({ kind: 'chat', messages, thread: { id: 9, title: 'Series help' } }, readOf({ kind: 'topic', prompt: '' })),
      { kind: 'chat', threadId: 9, title: 'Series help', messages: 2 });
    assert.deepEqual(originOf({ kind: 'topic', prompt: ' ratio test ' }, { pages: [], notes: [] }), { kind: 'topic', prompt: 'ratio test' });
    assert.deepEqual(originOf({ kind: 'mistakes', items: [{ prompt: 'p', answer: 'a', explanation: '', topic: '' }] }, { pages: [], notes: [] }),
      { kind: 'mistakes', count: 1 });
  });
});

describe('older decks and quizzes', () => {
  it('fall back to the sources their items cite, even without pages', () => {
    const origin = citedOrigin([refsOf({ sourceId: 1, title: 'Lecture 1' }), refsOf([{ sourceId: 1, title: 'Lecture 1', label: 'Page 3', unit: 2 }])]);
    assert.deepEqual(origin, { kind: 'sources', sources: [{ sourceId: 1, title: 'Lecture 1', kind: 'file', units: [[2, 2]] }], notes: [], focus: '' });
    assert.equal(citedOrigin([null, []]), null);
  });

  it('count each item once per source it cites', () => {
    const counts = citeCounts([
      [{ sourceId: 1, title: 'A', label: 'Page 1', unit: 0 }, { sourceId: 1, title: 'A', label: 'Page 2', unit: 1 }],
      [{ sourceId: 1, title: 'A', label: 'Page 3', unit: 2 }, { sourceId: 2, title: 'B', label: 'Page 1', unit: 0 }],
    ]);
    assert.deepEqual([...counts], [[1, 2], [2, 1]]);
  });
});

describe('how much of a source was used', () => {
  it('lists a few page runs, and counts otherwise', () => {
    assert.equal(coverage([[2, 6], [11, 11]], 'pdf', 40), 'pages 3–7, 12');
    assert.equal(coverage([[0, 0]], 'slides', 30), 'slide 1');
    assert.equal(coverage([[0, 1], [3, 3], [5, 5], [8, 9]], 'pdf', 40), '6 of 40 pages');
    assert.equal(coverage([[0, 3]], 'youtube'), '4 parts');
  });

  it('says all of it when every page was read, and nothing for a one-page source', () => {
    assert.equal(coverage([[0, 23]], 'pdf', 24), 'all 24 pages');
    assert.equal(coverage([[0, 0]], 'image', 1), '');
    assert.equal(coverage([], 'pdf', 10), '');
  });
});

describe('an origin read back from the database', () => {
  it('survives the round trip and throws out what makes no sense', () => {
    const origin = { kind: 'sources', sources: [{ sourceId: 1, title: 'A', kind: 'slides', units: [[0, 2]] }], notes: [{ id: 2, title: 'N' }], focus: 'f' };
    assert.deepEqual(asOrigin(JSON.parse(JSON.stringify(origin))), origin);
    assert.equal(asOrigin(null), null);
    assert.equal(asOrigin({ kind: 'nonsense' }), null);
    assert.deepEqual(asOrigin({ kind: 'sources', sources: [{ title: 'no id' }, { sourceId: 3, kind: 'odd', units: [[1], [2, 'x'], [4, 5]] }] }),
      { kind: 'sources', sources: [{ sourceId: 3, title: '', kind: 'file', units: [[4, 5]] }], notes: [], focus: '' });
  });
});
