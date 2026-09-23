/**
 * The walk a deck or quiz takes through the material. It decides what gets a
 * card and in what order, so it is tested on its own — no model involved.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyOrder, balancedTrim, budgets, CEILING, expectedItems, FULL_CONTEXT_CHARS, isShrunk, coreOnly, materialFor, pageId, uncovered, FAST_WINDOW_CHARS, fastMaterialFor, MAX_ITEMS, ordinalOf, pagesLabel, planWalk,
  readingOrder, sizeRule, WINDOW_CHARS, type Page, type WalkSource,
} from './deckPlan.ts';

const page = (sourceId: number, ord: number, chars: number, text = 'x'): Page => ({
  sourceId, sourceTitle: `S${sourceId}`, kind: 'pdf', ord, label: `Page ${ord + 1}`, text: text.repeat(Math.max(1, Math.floor(chars / text.length))),
});

const source = (id: number, pages: number, charsEach = 800): WalkSource => ({
  id, title: `Source ${id}`, kind: 'pdf',
  pages: Array.from({ length: pages }, (_, i) => page(id, i, charsEach)),
});

describe('the position a title claims', () => {
  it('reads the number after a word like "lecture"', () => {
    assert.equal(ordinalOf('Lecture 5, Equations of Planes, Interactions between Lines and Planes'), 5);
    assert.equal(ordinalOf('Week 03 - Kinematics'), 3);
    assert.equal(ordinalOf('Chapter 12'), 12);
    assert.equal(ordinalOf('MSK L1,L2 (inflamm, developmental)'), 1);
  });

  it('reads roman numerals and words', () => {
    assert.equal(ordinalOf('Part II: Series'), 2);
    assert.equal(ordinalOf('Lecture Three'), 3);
    assert.equal(ordinalOf('Session IV'), 4);
  });

  it('reads a number that opens the title', () => {
    assert.equal(ordinalOf('01 - Intro'), 1);
    assert.equal(ordinalOf('7. Osteoporosis'), 7);
  });

  it('does not mistake the subject for a position', () => {
    assert.equal(ordinalOf('Vectors and the 3 Dimensional Space'), null);
    assert.equal(ordinalOf("Newton's Laws"), null);
    assert.equal(ordinalOf('Pathology of bone'), null);
  });

  it('looks past a keyword that is not followed by a number', () => {
    assert.equal(ordinalOf('Lab safety, Lecture 3'), 3);
  });
});

describe('reading order', () => {
  it('puts lectures uploaded newest-first back in order', () => {
    // Exactly how the Calculus notebook was built: Lecture 5 went in first.
    const uploaded = [
      { id: 1, title: 'Lecture 5, Equations of Planes', createdAt: 1 },
      { id: 2, title: 'Lecture 4, Equations of Lines', createdAt: 2 },
      { id: 3, title: 'Lecture 3, The Cross Product', createdAt: 3 },
      { id: 4, title: 'Lecture 2, The Dot Product', createdAt: 4 },
      { id: 5, title: 'Lecture 1, Vectors and the 3 Dimensional Space', createdAt: 5 },
    ];
    assert.deepEqual(readingOrder(uploaded).map((s) => s.id), [5, 4, 3, 2, 1]);
  });

  it('keeps upload order for titles that say nothing, after the numbered ones', () => {
    const got = readingOrder([
      { id: 1, title: 'Revision sheet', createdAt: 1 },
      { id: 2, title: 'Lecture 2', createdAt: 2 },
      { id: 3, title: 'Extra reading', createdAt: 3 },
      { id: 4, title: 'Lecture 1', createdAt: 4 },
    ]);
    assert.deepEqual(got.map((s) => s.id), [4, 2, 1, 3]);
  });

  it('follows the order the student set, with anything new after it', () => {
    const all = [
      { id: 1, title: 'Lecture 1', createdAt: 1 },
      { id: 2, title: 'Lecture 2', createdAt: 2 },
      { id: 3, title: 'Lecture 3', createdAt: 3 },
    ];
    assert.deepEqual(applyOrder(all, [3, 1]).map((s) => s.id), [3, 1, 2]);
    // A source deleted since is simply gone from the order.
    assert.deepEqual(applyOrder(all, [9, 2]).map((s) => s.id), [2, 1, 3]);
  });
});

describe('the walk', () => {
  it('visits every page exactly once, in order', () => {
    const windows = planWalk([source(1, 40), source(2, 12)]);
    const visited = windows.flatMap((w) => w.pages.map((p) => `${p.sourceId}:${p.ord}`));
    const expected = [
      ...Array.from({ length: 40 }, (_, i) => `1:${i}`),
      ...Array.from({ length: 12 }, (_, i) => `2:${i}`),
    ];
    assert.deepEqual(visited, expected);
  });

  it('never runs one source into the next', () => {
    for (const w of planWalk([source(1, 5), source(2, 5)])) {
      assert.equal(new Set(w.pages.map((p) => p.sourceId)).size, 1);
    }
  });

  it('keeps each pass to a few pages', () => {
    for (const w of planWalk([source(1, 60)])) assert.ok(w.chars <= WINDOW_CHARS);
  });

  it('gives an oversized page a pass of its own rather than splitting it', () => {
    const big = { ...source(1, 3), pages: [page(1, 0, 500), page(1, 1, WINDOW_CHARS * 2), page(1, 2, 500)] };
    const windows = planWalk([big]);
    assert.deepEqual(windows.map((w) => w.pages.map((p) => p.ord)), [[0], [1], [2]]);
  });

});

describe('bringing a walk under the ceiling', () => {
  const card = (page: number, n: number) => ({ page: `Page ${page}`, n });
  const pageOf = (c: { page: string }) => c.page;

  it('leaves it alone when it is already under', () => {
    const items = [card(1, 0), card(2, 0)];
    assert.deepEqual(balancedTrim(items, pageOf, 10), items);
  });

  it('keeps at least one item from every page, the last page included', () => {
    // 49 pages, some wildly over-written, 200 items in all.
    const items = Array.from({ length: 49 }, (_, p) => Array.from({ length: p === 15 ? 26 : 4 }, (_, n) => card(p + 1, n))).flat();
    const kept = balancedTrim(items, pageOf, 128);
    assert.equal(kept.length, 128);
    for (let p = 1; p <= 49; p++) assert.ok(kept.some((c) => c.page === `Page ${p}`), `page ${p}`);
  });

  it('takes from the over-written pages first', () => {
    const items = [...Array.from({ length: 10 }, (_, n) => card(1, n)), card(2, 0), card(3, 0)];
    const kept = balancedTrim(items, pageOf, 6);
    assert.equal(kept.filter((c) => c.page === 'Page 2').length, 1);
    assert.equal(kept.filter((c) => c.page === 'Page 3').length, 1);
    assert.equal(kept.filter((c) => c.page === 'Page 1').length, 4);
  });

  it('lets a dense page keep more than a sparse one instead of flattening them', () => {
    // Twenty pages: five dense ones that wrote 10 each, fifteen that wrote 3.
    const items = Array.from({ length: 20 }, (_, p) => Array.from({ length: p % 4 === 0 ? 10 : 3 }, (_, n) => card(p + 1, n))).flat();
    const kept = balancedTrim(items, pageOf, 50);
    assert.equal(kept.length, 50);
    const on = (p: number) => kept.filter((c) => c.page === `Page ${p}`).length;
    assert.ok(on(1) >= 2 * on(2), `dense ${on(1)} vs sparse ${on(2)}`);
    for (let p = 1; p <= 20; p++) assert.ok(on(p) >= 1, `page ${p}`);
  });

  it('keeps each page\'s first item, which is its main point', () => {
    const items = [card(1, 0), card(1, 1), card(1, 2), card(2, 0), card(2, 1)];
    const kept = balancedTrim(items, pageOf, 2);
    assert.deepEqual(kept, [card(1, 0), card(2, 0)]);
  });

  it('spreads a tiny number across the whole material', () => {
    const items = Array.from({ length: 40 }, (_, p) => card(p + 1, 0));
    const kept = balancedTrim(items, pageOf, 4);
    assert.deepEqual(kept.map((c) => c.page), ['Page 1', 'Page 11', 'Page 21', 'Page 31']);
  });

  it('keeps the order', () => {
    const items = Array.from({ length: 30 }, (_, i) => card(1 + (i % 5), i));
    const kept = balancedTrim(items, pageOf, 12);
    assert.deepEqual(kept, items.filter((x) => kept.includes(x)));
  });

  it('drops the details before anything core', () => {
    // A page whose core point was written last still keeps it.
    const items = [
      { page: 'Page 1', n: 0, core: false }, { page: 'Page 1', n: 1, core: false }, { page: 'Page 1', n: 2, core: true },
      { page: 'Page 2', n: 0, core: true }, { page: 'Page 2', n: 1, core: false },
    ];
    const kept = balancedTrim(items, pageOf, 2, (c) => c.core);
    assert.deepEqual(kept.map((c) => `${c.page}:${c.n}`), ['Page 1:2', 'Page 2:0']);
  });
});

describe('how many a deck comes to', () => {
  const lecture = planWalk([source(1, 49)]);
  const chars = lecture.reduce((n, w) => n + w.chars, 0);

  it('puts a long lecture near the top of each band: fewer ≤32, standard 32–64, more 64–96', () => {
    const b = budgets(chars);
    assert.ok(b.fewer > 8 && b.fewer <= 32, `fewer ${b.fewer}`);
    assert.ok(b.standard >= 32 && b.standard <= 64, `standard ${b.standard}`);
    assert.ok(b.more >= 64 && b.more <= 96, `more ${b.more}`);
    assert.equal(MAX_ITEMS, 96);
  });

  it('lands lower in the band for a shorter lecture — it is not always the same number', () => {
    const half = budgets(chars / 2);
    const full = budgets(chars);
    assert.ok(half.standard < full.standard && half.standard >= 32, `${half.standard} vs ${full.standard}`);
    assert.ok(half.more < full.more && half.more >= 64, `${half.more} vs ${full.more}`);
  });

  it('makes a quiz exactly 8, 16 or 28, whatever the material', () => {
    for (const c of [2_000, chars, 400_000]) assert.deepEqual(budgets(c, undefined, 'questions'), { fewer: 8, standard: 16, more: 28 });
  });

  it('does not pad a short lecture up to the ceiling', () => {
    const b = budgets(planWalk([source(1, 8)]).reduce((n, w) => n + w.chars, 0));
    assert.ok(b.more < 60, `more ${b.more}`);
    assert.ok(b.standard < 40, `standard ${b.standard}`);
  });

  it('is always Fewer below Standard below More, however much or little there is', () => {
    for (const c of [0, 40, 200, 500, 1_000, 3_000, 10_000, 30_000, 100_000, 1_000_000]) {
      const b = budgets(c);
      assert.ok(b.fewer < b.standard || b.standard === 1, `${c}: ${JSON.stringify(b)}`);
      assert.ok(b.standard < b.more, `${c}: ${JSON.stringify(b)}`);
      assert.ok(b.more <= MAX_ITEMS && b.fewer >= 1);
    }
  });

  it('takes a number the student asked for, within MAX_ITEMS', () => {
    assert.equal(budgets(chars, 20).standard, 20);
    assert.equal(budgets(chars, 500).more, MAX_ITEMS);
    assert.equal(budgets(chars, 12, 'questions').standard, 12);
  });

  it('shares the deck across the passes by length, so the last pages get theirs', () => {
    const course = [source(1, 200), source(2, 200)];
    const windows = planWalk(course);
    const told = windows.map((w) => expectedItems(w, windows, 'standard'));
    const total = told.reduce((n, x) => n + x, 0);
    assert.ok(Math.abs(total - CEILING.standard) <= windows.length, `told ${total}`);
    assert.ok(told.at(-1)! >= 1);
  });

  it('tells a pass on Fewer the same scale as Standard — the choosing is done afterwards', () => {
    const w = lecture[0];
    assert.equal(expectedItems(w, lecture, 'fewer'), expectedItems(w, lecture, 'standard'));
    assert.ok(expectedItems(w, lecture, 'more') > expectedItems(w, lecture, 'standard'));
  });

  it('only says the deck is being kept short when the ceiling actually binds', () => {
    assert.ok(isShrunk(lecture, 'standard'));
    assert.ok(!isShrunk(planWalk([source(1, 8)]), 'standard'));
    assert.ok(!isShrunk(planWalk([source(1, 8)]), 'more'));
  });

  it('follows the length of the pages', () => {
    const windows = planWalk([source(1, 60)]);
    const short = { chars: 1500 };
    assert.ok(expectedItems(windows[0], windows, 'standard') > expectedItems(short, windows, 'standard'));
  });
});

describe('what each pass is shown', () => {
  it('is all of the material when it fits, identical for every pass', () => {
    const sources = [source(1, 5, 300), source(2, 5, 300)];
    const a = materialFor(sources, 1);
    assert.equal(a, materialFor(sources, 2), 'one shared prefix, so it can be cached');
    assert.match(a, /=== Source 1 ===/);
    assert.match(a, /=== Source 2 ===/);
    assert.match(a, /--- Page 5 ---/);
  });

  it('is the source being walked in full and the rest in outline when it does not', () => {
    const huge = Math.ceil(FULL_CONTEXT_CHARS / 20);
    const sources = [source(1, 20, huge), source(2, 20, huge)];
    const got = materialFor(sources, 2);
    assert.match(got, /=== Source 1 \(outline\) ===/);
    assert.match(got, /=== Source 2 ===/);
  });
});

describe('how thorough a pass is', () => {
  it('writes fewer exactly like standard — the difference is made afterwards', () => {
    // Asked for "only the essentials" beside a dozen lines about leaving
    // nothing out, a model writes everything anyway; so it is not asked.
    assert.equal(sizeRule('fewer', 'cards'), sizeRule('standard', 'cards'));
    assert.match(sizeRule('standard', 'cards'), /Do not summarise/);
  });

  it('asks more for extras beyond a complete pass', () => {
    assert.notEqual(sizeRule('more', 'cards'), sizeRule('standard', 'cards'));
    assert.match(sizeRule('more', 'questions'), /question for every fact/);
  });

  it('asks every setting to mark what is core', () => {
    for (const size of ['fewer', 'standard', 'more'] as const) assert.match(sizeRule(size, 'cards'), /core/);
  });
});

describe('what Fewer keeps', () => {
  const item = (page: number, n: number, core: boolean) => ({ page: `Page ${page}`, n, core });
  const pageOf = (c: { page: string }) => c.page;
  const isCore = (c: { core: boolean }) => c.core;

  it('keeps the core and drops the details', () => {
    const items = [item(1, 0, true), item(1, 1, false), item(2, 0, false), item(2, 1, true)];
    assert.deepEqual(coreOnly(items, pageOf, isCore).map((c) => `${c.page}:${c.n}`), ['Page 1:0', 'Page 2:1']);
  });

  it('keeps the first item of a page with nothing marked core, so no page is lost', () => {
    const items = [item(1, 0, true), item(2, 0, false), item(2, 1, false), item(3, 0, true)];
    assert.deepEqual(coreOnly(items, pageOf, isCore).map((c) => `${c.page}:${c.n}`), ['Page 1:0', 'Page 2:0', 'Page 3:0']);
  });
});

describe('pages a pass stopped short of', () => {
  const window = planWalk([source(1, 7)])[0];

  it('are nothing when every page got something', () => {
    assert.equal(uncovered(window, new Set(window.pages.map(pageId))), null);
  });

  it('are the pages that got nothing, as a window of their own', () => {
    const covered = new Set(window.pages.slice(0, 4).map(pageId));
    const gap = uncovered(window, covered)!;
    assert.deepEqual(gap.pages.map((p) => p.ord), [4, 5, 6]);
    assert.equal(gap.from, 'Page 5');
    assert.equal(gap.to, 'Page 7');
  });

  it('do not include a short title slide', () => {
    const w = { ...window, pages: [{ ...page(1, 0, 0), text: 'Highlights on Pathology of Bone and skin\nAssistant Prof. Someone\nDepartment of Pathology' }, page(1, 1, 800)] };
    assert.equal(uncovered(w, new Set([pageId(w.pages[1])])), null);
  });

  it('do not include a page with next to nothing on it', () => {
    const w = { ...window, pages: [page(1, 0, 800), { ...page(1, 1, 0), text: 'Scanned page\nScanned page\nPart II' }] };
    assert.equal(uncovered(w, new Set([pageId(w.pages[0])])), null);
  });
});

describe('fast mode', () => {
  it('walks in half as many passes', () => {
    const lecture = [source(1, 49)];
    assert.ok(planWalk(lecture, FAST_WINDOW_CHARS).length * 2 <= planWalk(lecture).length + 1);
    for (const w of planWalk(lecture, FAST_WINDOW_CHARS)) assert.ok(w.chars <= FAST_WINDOW_CHARS);
  });

  it('shows a pass an outline of everything and only its own pages in full', () => {
    const sources = [{ ...source(1, 20, 800), pages: Array.from({ length: 20 }, (_, i) => ({ ...page(1, i, 0), text: `Heading ${i + 1}\n${'body '.repeat(150)}` })) }];
    const [first] = planWalk(sources, FAST_WINDOW_CHARS);
    const fast = fastMaterialFor(sources, first);
    const full = materialFor(sources, 1);
    assert.match(fast, /Page 20: Heading 20/, 'the outline reaches the end');
    assert.ok(fast.length < full.length * 0.8, `${fast.length} vs ${full.length}`);
    assert.match(fast, /--- Page 1 ---/);
    assert.doesNotMatch(fast, /--- Page 20 ---/);
  });
});
