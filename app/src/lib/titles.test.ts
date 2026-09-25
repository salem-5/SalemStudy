import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { headingOf, tidyTitle } from './titles.ts';

describe('tidying a generated title', () => {
  const msk = ['MSK Lecture 4 - Bone healing', 'MSK Lecture 5 - Osteomyelitis'];

  it('drops the prefix the source files share', () => {
    assert.equal(tidyTitle('MSK Bone healing and osteomyelitis', msk), 'Bone healing and osteomyelitis');
    assert.equal(tidyTitle('MSK Lecture 4 - Bone healing', msk), 'Bone healing');
    assert.equal(tidyTitle('MSK: Fracture repair', ['MSK - Fractures']), 'Fracture repair');
  });

  it('drops numbered labels and a trailing kind word', () => {
    assert.equal(tidyTitle('Week 3: Convergence tests quiz', []), 'Convergence tests');
    assert.equal(tidyTitle('Chapter 2 Power series flashcards', []), 'Power series');
    assert.equal(tidyTitle('"Series convergence."', []), 'Series convergence');
  });

  it('keeps an acronym that is the subject itself', () => {
    assert.equal(tidyTitle('DNA replication', ['DNA replication lecture']), 'DNA replication');
    assert.equal(tidyTitle('ECG interpretation', ['Cardiology week 2']), 'ECG interpretation');
  });

  it('keeps a title it would otherwise empty', () => {
    assert.equal(tidyTitle('MSK', msk), 'MSK');
    assert.equal(tidyTitle('Quiz', []), 'Quiz');
  });

  it('keeps long titles short', () => {
    assert.equal(tidyTitle('Bone healing stages complications and the management of open fractures', []), 'Bone healing stages complications');
  });
});

describe('the title pasted text gives itself', () => {
  it('takes a Markdown heading', () => {
    assert.equal(headingOf('# Ratio test\n\nIf the limit is below one…'), 'Ratio test');
    assert.equal(headingOf('\n\n## **Power series**\nSome text'), 'Power series');
  });

  it('takes a short first line standing above the rest', () => {
    assert.equal(headingOf('Bone healing stages\n\nInflammation, soft callus, hard callus, remodelling.'), 'Bone healing stages');
  });

  it('leaves prose to be named', () => {
    assert.equal(headingOf('The ratio test says that if the limit is below one, the series converges.'), null);
    assert.equal(headingOf('Short line\nstraight into more text'), null);
    assert.equal(headingOf('Just one line'), null);
    assert.equal(headingOf('A sentence that ends.\n\nMore.'), null);
    assert.equal(headingOf('   '), null);
  });
});
