import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { groupLabel, groupNotes } from './padDates.ts';

const now = new Date(2026, 8, 24, 15, 0).getTime(); // 24 Sep 2026, 15:00
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).getTime();

describe('grouping notes by when they were last changed', () => {
  it('uses the same groups as Apple Notes', () => {
    assert.equal(groupLabel(at(2026, 8, 24, 9), now), 'Today');
    assert.equal(groupLabel(at(2026, 8, 23), now), 'Yesterday');
    assert.equal(groupLabel(at(2026, 8, 19), now), 'Previous 7 Days');
    assert.equal(groupLabel(at(2026, 8, 1), now), 'Previous 30 Days');
    assert.match(groupLabel(at(2026, 5, 3), now), /^\S+$/, 'a month this year has no year');
    assert.match(groupLabel(at(2025, 5, 3), now), /2025$/);
  });

  it('puts pinned notes first, then the rest newest first, in order of the groups', () => {
    const notes = [
      { id: 1, pinned: false, updatedAt: at(2026, 8, 1) },
      { id: 2, pinned: true, updatedAt: at(2026, 0, 1) },
      { id: 3, pinned: false, updatedAt: at(2026, 8, 24, 10) },
      { id: 4, pinned: false, updatedAt: at(2026, 8, 24, 14) },
    ];
    const groups = groupNotes(notes, now);
    assert.deepEqual(groups.map((g) => g.label), ['Pinned', 'Today', 'Previous 30 Days']);
    assert.deepEqual(groups[1].notes.map((n) => n.id), [4, 3]);
  });
});
