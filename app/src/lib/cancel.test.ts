import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createStop, isStop } from './cancel.ts';

describe('stopping work part-way', () => {
  it('runs what was registered, once, and throws "stopped" from then on', () => {
    const stop = createStop();
    let cancelled = 0;
    stop.onStop(() => { cancelled++; });
    const off = stop.onStop(() => { cancelled += 10; });
    off();
    assert.doesNotThrow(() => stop.throwIfStopped());
    stop.stop();
    stop.stop();
    assert.equal(cancelled, 1, 'an unsubscribed request is not cancelled, and nothing runs twice');
    assert.ok(stop.stopped);
    assert.throws(() => stop.throwIfStopped(), (e) => isStop(e));
  });

  it('cancels something registered after the stop at once', () => {
    const stop = createStop();
    stop.stop();
    let ran = false;
    stop.onStop(() => { ran = true; });
    assert.ok(ran);
  });

  it('keeps going when one cancel fails', () => {
    const stop = createStop();
    let second = false;
    stop.onStop(() => { throw new Error('boom'); });
    stop.onStop(() => { second = true; });
    stop.stop();
    assert.ok(second);
  });
});
