import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { changelogPlan } from './updater.ts';

describe('the changelog shown after an update', () => {
  const pending = { version: '0.2.0', notes: '- faster quizzes' };

  it('shows the notes the update brought, once that version is running', () => {
    assert.deepEqual(changelogPlan('0.2.0', pending, '0.1.0'), { show: pending });
  });

  it('waits while the downloaded version has not started yet', () => {
    assert.equal(changelogPlan('0.1.0', pending, '0.1.0'), null);
  });

  it('fetches the notes when the version changed some other way', () => {
    assert.deepEqual(changelogPlan('0.3.0', null, '0.2.0'), { fetch: '0.3.0' });
  });

  it('shows nothing on a first install or an unchanged version', () => {
    assert.equal(changelogPlan('0.1.0', null, null), null);
    assert.equal(changelogPlan('0.1.0', null, '0.1.0'), null);
  });
});
