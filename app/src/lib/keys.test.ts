import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { keys } from './keys.ts';

describe('writing a shortcut for this computer', () => {
  it('keeps the Mac symbols on a Mac', () => {
    assert.equal(keys('⌘K', true), '⌘K');
    assert.equal(keys('⌘↵', true), '⌘↵');
  });

  it('spells them out with Ctrl elsewhere', () => {
    assert.equal(keys('⌘K', false), 'Ctrl+K');
    assert.equal(keys('⌘⇧P', false), 'Ctrl+Shift+P');
    assert.equal(keys('⌘↵', false), 'Ctrl+Enter');
    assert.equal(keys('⌥⌘V', false), 'Alt+Ctrl+V');
  });
});
