import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeReferences, makeReference, referencedSources, referenceTag, type Reference } from './reference.ts';

const noteRef = (over: Partial<Reference> = {}): Reference => ({
  ...makeReference('note', 'Sequences', 'A sequence is an ordered list of numbers.', { noteId: 4, notebookId: 1 }, 'your note'),
  ...over,
});

describe('describing a reference', () => {
  it('quotes what was actually selected', () => {
    const text = describeReferences([noteRef()]);
    assert.match(text, /> A sequence is an ordered list of numbers\./);
  });

  it('hands over the material when it has been fetched', () => {
    const text = describeReferences([noteRef({
      content: { title: 'The note “Series”', body: 'Everything the note says.' },
    })]);
    assert.match(text, /The note “Series”, in full/);
    assert.match(text, /Everything the note says\./);
    assert.doesNotMatch(text, /read_note\(/);
  });

  it('says where to look only when the material could not be read', () => {
    const text = describeReferences([noteRef()]);
    assert.match(text, /could not be read from here/);
    assert.match(text, /read_note\(noteId: 4\)/);
  });

  it('leaves out a reference the briefing already spells out', () => {
    const quiz: Reference = {
      ...makeReference('quiz', 'Question 1', 'The ratio test gives L = 1.', { quizId: 2, questionIndex: 0 }, 'Convergence'),
      briefed: true,
    };
    assert.equal(describeReferences([quiz]), '');
  });

  it('still describes the un-briefed ones beside a briefed one', () => {
    const quiz: Reference = { ...makeReference('quiz', 'Question 1', 'q', { quizId: 2 }), briefed: true };
    const text = describeReferences([quiz, noteRef()]);
    assert.match(text, /Sequences/);
    assert.doesNotMatch(text, /Question 1/);
  });

  it('says nothing at all when nothing was pointed at', () => {
    assert.equal(describeReferences([]), '');
  });
});

describe('the excerpt', () => {
  it('is flattened, so a selection across lines reads as one quote', () => {
    const ref = makeReference('note', 'N', 'first line\n\n   second line', { noteId: 1 });
    assert.equal(ref.excerpt, 'first line second line');
  });

  it('is clipped, so a whole chapter does not become the prompt', () => {
    const ref = makeReference('note', 'N', 'x'.repeat(5000), { noteId: 1 });
    assert.ok(ref.excerpt.length < 1300);
    assert.ok(ref.excerpt.endsWith('…'));
  });
});

describe('the tag and the sources', () => {
  it('names the first and counts the rest', () => {
    assert.equal(referenceTag([noteRef()]), 'Sequences');
    assert.equal(referenceTag([noteRef(), noteRef()]), 'Sequences +1');
    assert.equal(referenceTag([]), undefined);
  });

  it('collects the sources a run may read, without repeats', () => {
    const a = makeReference('source', 'A', 'x', { sourceId: 3, unit: 2 });
    const b = makeReference('source', 'B', 'y', { sourceId: 3, unit: 9 });
    const c = makeReference('source', 'C', 'z', { sourceId: 7 });
    assert.deepEqual(referencedSources([a, b, c]), [3, 7]);
    assert.deepEqual(referencedSources([noteRef()]), []);
  });
});
