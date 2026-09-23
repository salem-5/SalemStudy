/**
 * Reconciling a fresh WebAssign listing against what we already knew.
 *
 * The rule that matters: a date only ever changes because WebAssign said a
 * new one. Nothing here may invent, lose or silently overwrite a due date.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeChanges, FORGET_AFTER, needsRefresh, reconcile, type CachedAssignment } from './assignmentCache.ts';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

const cached = (over: Partial<CachedAssignment> = {}): CachedAssignment => ({
  id: 1, title: '12.3 (ET9)', due: NOW + DAY, dueText: 'Fri 23:59', seenAt: NOW - DAY, ...over,
});

describe('a first look', () => {
  it('takes everything WebAssign listed', () => {
    const r = reconcile([], [{ id: 1, title: 'A', due: NOW, dueText: 'today' }], NOW);
    assert.equal(r.assignments.length, 1);
    assert.equal(r.added.length, 1);
    assert.equal(r.assignments[0].seenAt, NOW);
  });
});

describe('a due date that moved', () => {
  it('is picked up and recorded', () => {
    const r = reconcile([cached()], [{ id: 1, title: '12.3 (ET9)', due: NOW + 3 * DAY, dueText: 'Mon 23:59' }], NOW);
    assert.equal(r.assignments[0].due, NOW + 3 * DAY);
    assert.equal(r.moved.length, 1);
    assert.equal(r.moved[0].from, NOW + DAY);
    assert.equal(r.assignments[0].movedFrom, NOW + DAY);
  });

  it('keeps what WebAssign actually printed beside it', () => {
    const r = reconcile([cached()], [{ id: 1, title: '12.3 (ET9)', due: NOW + 3 * DAY, dueText: 'Mon 11:59 PM' }], NOW);
    assert.equal(r.assignments[0].dueText, 'Mon 11:59 PM');
  });

  it('is not reported when the date is the same', () => {
    const r = reconcile([cached()], [{ id: 1, title: '12.3 (ET9)', due: NOW + DAY, dueText: 'Fri 23:59' }], NOW);
    assert.equal(r.moved.length, 0);
  });
});

describe('a date that could not be read', () => {
  it('leaves the one we had rather than blanking it', () => {
    const r = reconcile([cached()], [{ id: 1, title: '12.3 (ET9)', due: null, dueText: '' }], NOW);
    assert.equal(r.assignments[0].due, NOW + DAY, 'an unreadable date must not erase a known one');
    assert.equal(r.assignments[0].dueText, 'Fri 23:59');
    assert.equal(r.moved.length, 0, 'and must not be reported as a change');
  });
});

describe('an assignment that is no longer listed', () => {
  it('is marked, not deleted', () => {
    const r = reconcile([cached()], [], NOW);
    assert.equal(r.assignments.length, 1);
    assert.equal(r.assignments[0].missingSince, NOW);
    assert.equal(r.missing.length, 1);
  });

  it('keeps the same "missing since" on the next look', () => {
    const first = reconcile([cached()], [], NOW);
    const second = reconcile(first.assignments, [], NOW + DAY);
    assert.equal(second.assignments[0].missingSince, NOW);
  });

  it('is finally dropped once it has been gone long enough', () => {
    const gone = reconcile([cached()], [], NOW).assignments;
    const later = reconcile(gone, [], NOW + FORGET_AFTER + DAY);
    assert.equal(later.assignments.length, 0);
  });

  it('comes back cleanly if WebAssign lists it again', () => {
    const gone = reconcile([cached()], [], NOW).assignments;
    const back = reconcile(gone, [{ id: 1, title: '12.3 (ET9)', due: NOW + DAY, dueText: 'Fri 23:59' }], NOW + DAY);
    assert.equal(back.assignments[0].missingSince, undefined);
    assert.equal(back.returned.length, 1);
  });
});

describe('the list as a whole', () => {
  it('comes back in due-date order, with undated ones last', () => {
    const r = reconcile([], [
      { id: 3, title: 'C', due: null, dueText: '' },
      { id: 2, title: 'B', due: NOW + 2 * DAY, dueText: '' },
      { id: 1, title: 'A', due: NOW + DAY, dueText: '' },
    ], NOW);
    assert.deepEqual(r.assignments.map((a) => a.id), [1, 2, 3]);
  });

  it('is summarised for the student only when something changed', () => {
    assert.equal(describeChanges(reconcile([cached()], [{ id: 1, title: 'A', due: NOW + DAY, dueText: '' }], NOW)), null);
    const moved = reconcile([cached()], [{ id: 1, title: '12.3 (ET9)', due: NOW + 5 * DAY, dueText: '' }], NOW);
    assert.match(String(describeChanges(moved)), /moved/);
  });
});

describe('when to ask WebAssign again', () => {
  it('asks when there is nothing cached', () => {
    assert.equal(needsRefresh([], NOW), true);
  });

  it('does not ask again straight away', () => {
    assert.equal(needsRefresh([cached({ seenAt: NOW })], NOW + 1000), false);
  });

  it('asks once the cache has aged', () => {
    assert.equal(needsRefresh([cached({ seenAt: NOW })], NOW + 30 * 60_000), true);
  });
});
