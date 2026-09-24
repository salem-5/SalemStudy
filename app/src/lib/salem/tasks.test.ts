/**
 * Background work, and keeping two jobs off the same rows.
 *
 * The locking is the part that matters: a student who starts a second quiz
 * generation on a notebook while the first is still writing should be told,
 * not quietly given a race.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

let tasksModule: typeof import('./tasks');

// The store is imported once and reset between tests; it pulls in `runtime`
// only for cancelling, which is stubbed here.
const setup = async () => {
  if (!tasksModule) {
    (globalThis as Record<string, unknown>).window = {};
    tasksModule = await import('./tasks.ts');
  }
  tasksModule.resetTasks();
  return tasksModule;
};

const defer = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

beforeEach(setup);

describe('running work in the background', () => {
  it('reports it as running, then as finished', async () => {
    const { runInBackground, runningCount } = await setup();
    const gate = defer<string>();
    const job = runInBackground({ label: 'Writing a quiz', scope: 'nb:1:quiz', describe: (r: string) => r }, () => gate.promise);
    assert.equal(runningCount(), 1);
    gate.resolve('Saved “Series” (12 questions)');
    assert.equal(await job, 'Saved “Series” (12 questions)');
    assert.equal(runningCount(), 0);
  });

  it('passes progress through to the tray', async () => {
    const { runInBackground, holderOf } = await setup();
    const gate = defer<void>();
    const job = runInBackground({ label: 'Writing a quiz', scope: 'nb:1:quiz' }, async (progress) => {
      progress('Reading your sources…');
      await gate.promise;
    });
    assert.equal(holderOf('nb:1:quiz')?.detail, 'Reading your sources…');
    gate.resolve();
    await job;
  });

  it('keeps a failure, with its reason', async () => {
    const { runInBackground, holderOf } = await setup();
    await assert.rejects(
      runInBackground({ label: 'Writing a quiz', scope: 'nb:1:quiz' }, async () => { throw new Error('no readable text'); }),
      /no readable text/,
    );
    // It is no longer holding the scope, so the student can try again.
    assert.equal(holderOf('nb:1:quiz'), undefined);
  });
});

describe('keeping conflicting work apart', () => {
  it('refuses a second job on the same scope', async () => {
    const { runInBackground, ScopeBusy } = await setup();
    const gate = defer<void>();
    const first = runInBackground({ label: 'Writing a quiz', scope: 'nb:1:quiz' }, () => gate.promise);
    await assert.rejects(
      runInBackground({ label: 'Writing a quiz', scope: 'nb:1:quiz' }, async () => {}),
      (e: unknown) => e instanceof ScopeBusy,
    );
    gate.resolve();
    await first;
  });

  it('says what is already running, so the message can be useful', async () => {
    const { runInBackground, ScopeBusy } = await setup();
    const gate = defer<void>();
    const first = runInBackground({ label: 'Writing a 40-question quiz', scope: 'nb:1:quiz' }, () => gate.promise);
    await runInBackground({ label: 'x', scope: 'nb:1:quiz' }, async () => {}).catch((e) => {
      assert.ok(e instanceof ScopeBusy);
      assert.match(e.message, /40-question quiz/);
    });
    gate.resolve();
    await first;
  });

  it('lets different scopes run at once', async () => {
    const { runInBackground, runningCount } = await setup();
    const a = defer<void>();
    const b = defer<void>();
    const first = runInBackground({ label: 'Quiz', scope: 'nb:1:quiz' }, () => a.promise);
    const second = runInBackground({ label: 'Deck', scope: 'nb:1:deck' }, () => b.promise);
    assert.equal(runningCount(), 2);
    a.resolve(); b.resolve();
    await Promise.all([first, second]);
  });

  it('frees the scope once the work is over', async () => {
    const { runInBackground } = await setup();
    await runInBackground({ label: 'Quiz', scope: 'nb:1:quiz' }, async () => {});
    // The second one starts without complaint.
    await runInBackground({ label: 'Quiz', scope: 'nb:1:quiz' }, async () => {});
  });
});

describe('stopping', () => {
  it('reaches the work itself, and a stopped job never counts as done', async () => {
    const { runInBackground, stopTask, useTasks: _u, holderOf } = await setup();
    let sawStop = false;
    let cancelledRequest = false;
    const gate = defer<void>();
    const job = runInBackground({ label: 'Writing a deck', scope: 'nb:1:decks' }, async (_p, _m, stop) => {
      stop.onStop(() => { cancelledRequest = true; });
      await gate.promise;
      sawStop = stop.stopped;
      return 'saved';
    });
    stopTask(holderOf('nb:1:decks')!.id);
    gate.resolve();
    await assert.rejects(job, /stopped/, 'finishing after the stop is still a stop');
    assert.ok(sawStop, 'the work can see it was stopped');
    assert.ok(cancelledRequest, 'what it registered (a request) is cancelled');
  });
});

describe('the tray', () => {
  it('stops a running task', async () => {
    const { runInBackground, holderOf, stopTask, runningCount } = await setup();
    const gate = defer<void>();
    const job = runInBackground({ label: 'Quiz', scope: 'nb:1:quiz' }, () => gate.promise);
    stopTask(holderOf('nb:1:quiz')!.id);
    assert.equal(runningCount(), 0, 'a stopped task stops holding its scope');
    gate.resolve();
    await assert.rejects(job, /stopped/, 'and its result is not taken');
  });

  it('only dismisses what has finished', async () => {
    const { runInBackground, dismissTask, dismissFinished, holderOf, runningCount } = await setup();
    const gate = defer<void>();
    const job = runInBackground({ label: 'Quiz', scope: 'nb:1:quiz' }, () => gate.promise);
    const id = holderOf('nb:1:quiz')!.id;
    dismissTask(id);
    assert.equal(runningCount(), 1, 'a running task cannot be dismissed');
    gate.resolve();
    await job;
    dismissFinished();
    assert.equal(runningCount(), 0);
  });
});
