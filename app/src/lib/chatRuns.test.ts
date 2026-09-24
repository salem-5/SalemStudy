import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  beginRun, chatRunning, currentRun, endRun, isStopped, resetChatRuns, stopRun, updateRun,
} from './chatRuns.ts';

beforeEach(() => resetChatRuns());

describe('a turn in flight', () => {
  it('is visible to anyone who asks, not just the view that started it', () => {
    beginRun(7, 'why is this wrong?');
    assert.equal(chatRunning(7), true);
    assert.equal(currentRun(7)?.question, 'why is this wrong?');
  });

  it('keeps the progress folded into it', () => {
    beginRun(7, 'q');
    updateRun(7, { state: 'running_python', detail: 'Checking it' });
    assert.equal(currentRun(7)?.state, 'running_python');
    assert.equal(currentRun(7)?.detail, 'Checking it');
  });

  it('gives React a new object each time, so a view re-renders', () => {
    beginRun(7, 'q');
    const before = currentRun(7)!.version;
    updateRun(7, { detail: 'one' });
    assert.equal(currentRun(7)!.version, before + 1);
  });

  it('keeps two chats apart', () => {
    beginRun(1, 'a');
    beginRun(2, 'b');
    updateRun(1, { detail: 'only mine' });
    assert.equal(currentRun(2)?.detail, '');
    assert.equal(chatRunning(2), true);
  });

  it('is gone once it lands', () => {
    beginRun(7, 'q');
    endRun(7);
    assert.equal(chatRunning(7), false);
    assert.equal(currentRun(7), undefined);
  });
});

describe('stopping', () => {
  it('raises the flag the turn itself checks', () => {
    beginRun(7, 'q');
    assert.equal(isStopped(7), false);
    stopRun(7);
    assert.equal(isStopped(7), true);
  });

  it('cuts the request already in flight', () => {
    beginRun(7, 'q');
    let aborted = false;
    updateRun(7, { abort: () => { aborted = true; } });
    stopRun(7);
    assert.equal(aborted, true);
  });

  it('does nothing to a chat that is not running', () => {
    assert.doesNotThrow(() => stopRun(99));
    assert.equal(isStopped(99), false);
  });

  it('leaves the run in place, so the turn can still save what it wrote', () => {
    beginRun(7, 'q');
    updateRun(7, { steps: [{ type: 'text', text: 'half an answer' }] });
    stopRun(7);
    assert.equal(chatRunning(7), true);
    assert.deepEqual(currentRun(7)?.steps, [{ type: 'text', text: 'half an answer' }]);
  });
});

describe('updates to a run that has finished', () => {
  it('are ignored rather than resurrecting it', () => {
    beginRun(7, 'q');
    endRun(7);
    updateRun(7, { detail: 'too late' });
    assert.equal(chatRunning(7), false);
  });
});
