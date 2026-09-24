import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { choosePages, narrowWalk, outlineForInstructions, toBrief } from './instructions.ts';
import type { WalkSource } from './deckPlan.ts';

const source = (id: number, title: string, pages: number): WalkSource => ({
  id, title, kind: 'pdf',
  pages: Array.from({ length: pages }, (_, i) => ({
    sourceId: id, sourceTitle: title, kind: 'pdf' as const, ord: i, label: `Page ${i + 1}`,
    text: i === pages - 1 ? 'Question 6. True or False? Prove or give a counterexample.\n(a) Every bounded sequence converges.' : `Question ${i + 1}. Compute the integral.`,
  })),
});

const walk = [source(1, 'Lecture 3 - Series', 12), source(2, 'Final exam 2022', 5), source(3, 'Final exam 2023', 6)];

describe('the outline the instructions are read against', () => {
  it('marks the last page of every source and says how long each is', () => {
    const outline = outlineForInstructions(walk);
    assert.match(outline, /=== Final exam 2022 - 5 pages ===/);
    assert.match(outline, /Page 5 \(last page\): Question 6\. True or False\?/);
    assert.match(outline, /Page 6 \(last page\)/);
    assert.doesNotMatch(outline, /Page 4 \(last page\)/);
  });
});

describe('choosing pages', () => {
  it('finds "the last page of each past paper" as the model names it', () => {
    const pages = choosePages(walk, [
      { source: 'Final exam 2022', pages: ['Page 5 (last page)'] },
      { source: 'final exam 2023', pages: ['last'] },
    ]);
    assert.deepEqual([...pages!].sort(), ['2:4', '3:5']);
  });

  it('takes bare numbers, and a whole source for "all" or no pages', () => {
    assert.deepEqual([...choosePages(walk, [{ source: 'Lecture 3 - Series', pages: ['3', 'page 4'] }])!].sort(), ['1:2', '1:3']);
    assert.equal(choosePages(walk, [{ source: 'Final exam 2022', pages: ['all'] }])!.size, 5);
    assert.equal(choosePages(walk, [{ source: 'Final exam 2022', pages: [] }])!.size, 5);
  });

  it('matches a title loosely, and ignores what does not exist', () => {
    const pages = choosePages(walk, [{ source: 'exam 2023', pages: ['Page 1'] }, { source: 'Midterm 2019', pages: ['Page 1'] }, { source: 'Final exam 2022', pages: ['Page 40'] }]);
    assert.deepEqual([...pages!], ['3:0']);
  });

  it('is nothing when nothing matched, so the whole material is used instead', () => {
    assert.equal(choosePages(walk, [{ source: 'Homework', pages: ['Page 1'] }]), null);
  });
});

describe('the brief', () => {
  it('narrows the walk to the chosen pages, dropping sources with none', () => {
    const brief = toBrief('only the true/false on the last page of past exams', walk, {
      all_pages: false, every_item: true, types: ['tf', 'essay'], rules: 'Full proof in the explanation.',
      use: [{ source: 'Final exam 2022', pages: ['Page 5'] }, { source: 'Final exam 2023', pages: ['Page 6'] }],
    });
    assert.equal(brief.everyItem, true);
    assert.deepEqual(brief.types, ['tf']);
    const narrowed = narrowWalk(walk, brief.pages);
    assert.deepEqual(narrowed.map((s) => s.title), ['Final exam 2022', 'Final exam 2023']);
    assert.deepEqual(narrowed.map((s) => s.pages.map((p) => p.label)), [['Page 5'], ['Page 6']]);
  });

  it('reads all pages when it says so, or when every page was chosen', () => {
    assert.equal(toBrief('x', walk, { all_pages: true, every_item: false, rules: '', use: [{ source: 'Final exam 2022', pages: ['Page 1'] }] }).pages, null);
    const everything = walk.map((s) => ({ source: s.title, pages: ['all'] }));
    assert.equal(toBrief('x', walk, { all_pages: false, every_item: false, rules: '', use: everything }).pages, null);
  });

  it('keeps a number only when it is one', () => {
    assert.equal(toBrief('x', walk, { all_pages: true, every_item: false, rules: '', count: 12 }).count, 12);
    assert.equal(toBrief('x', walk, { all_pages: true, every_item: false, rules: '', count: 0 }).count, undefined);
  });

  it('falls back to the instructions as written when they could not be read', () => {
    const brief = toBrief('only lecture 3', walk, null);
    assert.equal(brief.pages, null);
    assert.equal(brief.text, 'only lecture 3');
  });
});
