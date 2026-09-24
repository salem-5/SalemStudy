import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

type Stored = Map<string, string>;

function fakeDom(blocks: { anchor?: string; top: number; height: number; text?: string }[], scrollTop = 0) {
  const VIEWPORT_TOP = 100;
  const scroller = {
    scrollTop,
    clientHeight: 400,
    scrollHeight: Math.max(...blocks.map((b) => b.top + b.height), 400),
    getBoundingClientRect: () => ({ top: VIEWPORT_TOP }),
    querySelectorAll: (_selector: string) =>
      blocks
        .filter((b) => b.anchor)
        .map((b) => ({
          dataset: { anchor: b.anchor },
          getBoundingClientRect: () => ({
            top: VIEWPORT_TOP + b.top - scroller.scrollTop,
            bottom: VIEWPORT_TOP + b.top + b.height - scroller.scrollTop,
          }),
        })),
    querySelector: (selector: string) => {
      const wanted = /\[data-anchor="(.*)"\]/.exec(selector)?.[1];
      const found = blocks.find((b) => b.anchor === wanted);
      if (!found) return null;
      return {
        getBoundingClientRect: () => ({
          top: VIEWPORT_TOP + found.top - scroller.scrollTop,
          bottom: VIEWPORT_TOP + found.top + found.height - scroller.scrollTop,
        }),
      };
    },
  };
  return scroller as unknown as HTMLElement & { scrollTop: number };
}

let store: Stored;
let memory: typeof import('./scrollMemory');

before(async () => {
  store = new Map();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  memory = await import('./scrollMemory.ts');
});

describe('measuring a position', () => {
  it('anchors on the block the fold is inside, with how far into it', () => {
    const scroller = fakeDom([
      { anchor: 'a', top: 0, height: 200 },
      { anchor: 'b', top: 200, height: 300 },
      { anchor: 'c', top: 500, height: 200 },
    ], 260);
    const position = memory.measure(scroller);
    assert.equal(position.anchor, 'b', 'the fold at 260 is 60px into block b');
    assert.equal(position.within, 60);
    assert.equal(position.offset, 260);
  });

  it('falls back to the raw offset when nothing is anchored', () => {
    const scroller = fakeDom([{ top: 0, height: 900 }], 300);
    const position = memory.measure(scroller);
    assert.equal(position.anchor, undefined);
    assert.equal(position.offset, 300);
  });
});

describe('restoring a position', () => {
  it('puts the anchored block back under the fold', () => {
    const scroller = fakeDom([
      { anchor: 'a', top: 0, height: 200 },
      { anchor: 'b', top: 200, height: 300 },
    ], 0);
    const found = memory.restore(scroller, { offset: 9999, anchor: 'b', within: 60, at: Date.now() });
    assert.equal(found, true);
    assert.equal(scroller.scrollTop, 260, 'the offset is ignored when the anchor is found');
  });

  it('survives content being inserted above the anchor', () => {
    const scroller = fakeDom([
      { anchor: 'new', top: 0, height: 400 },
      { anchor: 'b', top: 600, height: 300 },
    ], 0);
    memory.restore(scroller, { offset: 260, anchor: 'b', within: 60, at: Date.now() });
    assert.equal(scroller.scrollTop, 660, 'it follows the block, not the pixel count');
  });

  it('uses the raw offset when the anchor is gone, clamped to the content', () => {
    const scroller = fakeDom([{ anchor: 'other', top: 0, height: 500 }], 0);
    const found = memory.restore(scroller, { offset: 5000, anchor: 'deleted', within: 10, at: Date.now() });
    assert.equal(found, false);
    assert.equal(scroller.scrollTop, 100, 'clamped to scrollHeight - clientHeight');
  });
});

describe('storage', () => {
  it('round-trips a position', () => {
    memory.savePosition('note-7', { offset: 300, anchor: 'x', within: 12, height: 900 });
    const back = memory.loadPosition('note-7');
    assert.equal(back?.offset, 300);
    assert.equal(back?.anchor, 'x');
  });

  it('keeps each chat and note apart', () => {
    memory.savePosition('chat-1', { offset: 100, anchor: 'm1' });
    memory.savePosition('chat-2', { offset: 800, anchor: 'm9' });
    assert.equal(memory.loadPosition('chat-1')?.anchor, 'm1');
    assert.equal(memory.loadPosition('chat-2')?.anchor, 'm9');
  });

  it('stores nothing for a view left at the top', () => {
    memory.savePosition('chat-3', { offset: 4 });
    assert.equal(memory.loadPosition('chat-3'), null);
  });

  it('drops a position that is too old to mean anything', () => {
    const old = Date.now() - 200 * 24 * 60 * 60 * 1000;
    store.set('wa.scroll.note-old', JSON.stringify({ offset: 300, anchor: 'x', at: old }));
    assert.equal(memory.loadPosition('note-old'), null);
  });

  it('ignores a corrupted entry rather than throwing', () => {
    store.set('wa.scroll.note-bad', 'not json');
    assert.equal(memory.loadPosition('note-bad'), null);
  });

  it('forgets on request', () => {
    memory.savePosition('note-9', { offset: 300, anchor: 'x' });
    memory.forgetPosition('note-9');
    assert.equal(memory.loadPosition('note-9'), null);
  });
});

describe('anchoring rendered markdown', () => {
  const container = (texts: string[]) => {
    const children = texts.map((text) => ({ textContent: text, dataset: {} as Record<string, string> }));
    return { children, dataset: {} } as unknown as HTMLElement & { children: { dataset: Record<string, string> }[] };
  };

  it('gives each block an anchor from its own words', () => {
    const el = container(['The Golgi apparatus', 'It packages proteins.']);
    memory.tagAnchors(el);
    const [first, second] = el.children;
    assert.ok(first.dataset.anchor);
    assert.notEqual(first.dataset.anchor, second.dataset.anchor);
  });

  it('gives the same block the same anchor after an edit above it', () => {
    const before_ = container(['Intro', 'It packages proteins.']);
    const after = container(['Intro', 'A new paragraph.', 'It packages proteins.']);
    memory.tagAnchors(before_);
    memory.tagAnchors(after);
    assert.equal(before_.children[1].dataset.anchor, after.children[2].dataset.anchor);
  });

  it('keeps repeated blocks distinct', () => {
    const el = container(['Same', 'Same']);
    memory.tagAnchors(el);
    assert.notEqual(el.children[0].dataset.anchor, el.children[1].dataset.anchor);
  });
});
