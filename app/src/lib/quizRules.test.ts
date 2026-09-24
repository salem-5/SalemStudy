import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkAgrees, fillsTheGap, gradeLocal, parseNumber, picked, shuffleChoices, unpick, usableHint } from './quizRules.ts';

const mcq = { type: 'mcq', prompt: 'p', choices: ['3x^2', 'x^2', '3x'], answer: 0, explanation: '', topic: 't' } as const;
const multi = { type: 'multi', prompt: 'p', choices: ['A', 'B', 'C', 'D'], answers: [0, 2], answer: '0,2', explanation: '', topic: 't' } as const;
const blank = { type: 'blank', prompt: 'The powerhouse is the ___.', answer: 'mitochondrion', accept: ['mitochondria'], explanation: '', topic: 't' } as const;
const numeric = { type: 'numeric', prompt: 'p', answer: 9.81, tolerance: 0.01, explanation: '', topic: 't' } as const;

describe('single select and true/false', () => {
  it('marks the right choice right', () => {
    assert.equal(gradeLocal(mcq, '0'), true);
    assert.equal(gradeLocal(mcq, '2'), false);
  });

  it('marks true/false', () => {
    const tf = { type: 'tf', prompt: 'p', answer: 'true', explanation: '', topic: 't' } as const;
    assert.equal(gradeLocal(tf, 'true'), true);
    assert.equal(gradeLocal(tf, 'false'), false);
  });
});

describe('multi-select', () => {
  it('needs every right choice and no wrong ones', () => {
    assert.equal(gradeLocal(multi, '0,2'), true);
    assert.equal(gradeLocal(multi, '2,0'), true, 'order must not matter');
    assert.equal(gradeLocal(multi, '0'), false, 'a partial answer is not right');
    assert.equal(gradeLocal(multi, '0,1,2'), false, 'an extra choice is not right');
  });

  it('round-trips the stored form', () => {
    assert.deepEqual(picked(unpick([2, 0])), [0, 2]);
    assert.deepEqual(picked('1, 3 ,1'), [1, 3], 'duplicates and spaces are tolerated');
    assert.deepEqual(picked(''), []);
  });
});

describe('fill-in-the-blank', () => {
  it('ignores case, spacing and punctuation', () => {
    assert.equal(fillsTheGap(blank, 'Mitochondrion'), true);
    assert.equal(fillsTheGap(blank, '  mitochondrion. '), true);
  });

  it('accepts the forms the question listed', () => {
    assert.equal(fillsTheGap(blank, 'mitochondria'), true);
  });

  it('accepts a plural of the answer', () => {
    assert.equal(fillsTheGap({ answer: 'ribosome' }, 'ribosomes'), true);
  });

  it('ignores a leading article', () => {
    assert.equal(fillsTheGap({ answer: 'nucleus' }, 'the nucleus'), true);
  });

  it('still marks a different word wrong', () => {
    assert.equal(fillsTheGap(blank, 'chloroplast'), false);
    assert.equal(fillsTheGap(blank, ''), false);
  });

  it('goes through gradeLocal', () => {
    assert.equal(gradeLocal(blank, 'Mitochondria'), true);
  });
});

describe('numeric answers', () => {
  it('reads fractions, decimals and units', () => {
    assert.equal(parseNumber('3/2'), 1.5);
    assert.equal(parseNumber('-0.5'), -0.5);
    assert.equal(parseNumber('1.2e3'), 1200);
    assert.equal(parseNumber('9.81 m/s^2'), 9.81);
    assert.equal(parseNumber('not a number'), null);
  });

  it('accepts an answer inside tolerance and rejects one outside', () => {
    assert.equal(gradeLocal(numeric, '9.815'), true);
    assert.equal(gradeLocal(numeric, '9.9'), false);
  });
});

describe('the independent Python check', () => {
  it('agrees when the last printed line matches', () => {
    assert.equal(checkAgrees(mcq, 'working…\n0'), true);
    assert.equal(checkAgrees(mcq, '2'), false);
    assert.equal(checkAgrees(multi, '[0, 2]'), true);
    assert.equal(checkAgrees(numeric, '9.8100'), true);
    assert.equal(checkAgrees(blank, 'Mitochondrion'), true);
  });

  it('does not agree with nothing at all', () => {
    assert.equal(checkAgrees(mcq, '   '), false);
  });
});

describe('hints', () => {
  it('keeps a hint that points at the idea', () => {
    assert.equal(usableHint('Bring the exponent down and drop it by one.', mcq),
                 'Bring the exponent down and drop it by one.');
  });

  it('drops a hint that names the correct choice', () => {
    assert.equal(usableHint('Remember that 3x^2 is what the power rule gives.', mcq), '');
  });

  it('drops a hint that names the option', () => {
    assert.equal(usableHint('The answer is the first one.', mcq), '');
    assert.equal(usableHint('Pick option B.', mcq), '');
  });

  it('drops a hint that gives away a true/false answer', () => {
    const tf = { type: 'tf', answer: 'true', prompt: 'p', explanation: '', topic: 't' } as const;
    assert.equal(usableHint('The statement is true because entropy rises.', tf), '');
    assert.equal(usableHint('Think about what happens to entropy in a closed system.', tf),
                 'Think about what happens to entropy in a closed system.');
  });

  it('drops a hint that spells out a blank', () => {
    assert.equal(usableHint('It is the mitochondrion.', blank), '');
    assert.equal(usableHint('Think about where ATP is made.', blank), 'Think about where ATP is made.');
  });

  it('drops a hint that states the number', () => {
    assert.equal(usableHint('It is about 9.81.', numeric), '');
  });

  it('treats an empty hint as no hint', () => {
    assert.equal(usableHint('   ', mcq), '');
  });
});

describe('shuffling the choices', () => {
  const reversing = () => 0;

  it('moves the answer key with the text', () => {
    const q = { type: 'mcq', prompt: 'p', choices: ['right', 'a', 'b', 'c'], answer: 0, explanation: '', topic: 't' } as const;
    const out = shuffleChoices(q, reversing);
    assert.equal(out.choices![Number(out.answer)], 'right', 'the marked choice must still be the right one');
    assert.deepEqual([...out.choices!].sort(), [...q.choices].sort(), 'no choice may be lost or invented');
  });

  it('moves every key of a multi-select', () => {
    const q = { type: 'multi', prompt: 'p', choices: ['A', 'B', 'C', 'D'], answers: [0, 2], answer: '0,2', explanation: '', topic: 't' } as const;
    const out = shuffleChoices(q, reversing);
    const marked = out.answers!.map((i) => out.choices![i]).sort();
    assert.deepEqual(marked, ['A', 'C']);
    assert.equal(out.answer, out.answers!.join(','), 'the stored form must match the keys');
  });

  it('leaves alone the types that have no choices', () => {
    const q = { type: 'numeric', prompt: 'p', answer: 4, explanation: '', topic: 't' } as const;
    assert.deepEqual(shuffleChoices(q, reversing), q);
  });

  it('actually moves the answer around over many draws', () => {
    const q = { type: 'mcq', prompt: 'p', choices: ['right', 'a', 'b', 'c'], answer: 0, explanation: '', topic: 't' } as const;
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(Number(shuffleChoices(q).answer));
    assert.ok(seen.size > 1, 'the right answer must not always land in the same place');
  });
});
