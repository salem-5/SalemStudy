import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkSchema, fitsSchema, parseJson, type Schema } from './schemaCheck.ts';

const QUIZ: Schema = {
  type: 'object',
  required: ['title', 'questions'],
  properties: {
    title: { type: 'string' },
    questions: {
      type: 'array',
      minItems: 2,
      items: {
        type: 'object',
        required: ['prompt', 'choices', 'answer'],
        properties: {
          prompt: { type: 'string' },
          choices: { type: 'array', items: { type: 'string' } },
          answer: { type: 'integer' },
          difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
        },
      },
    },
  },
};

const question = (over: Record<string, unknown> = {}) =>
  ({ prompt: 'p', choices: ['a', 'b'], answer: 0, ...over });

describe('parseJson', () => {
  it('reads an object out of a reply that has prose around it', () => {
    const got = parseJson('Here you go:\n```json\n{"a": 1}\n```\nHope that helps.');
    assert.deepEqual(got, { value: { a: 1 } });
  });

  it('reads a bare array', () => {
    assert.deepEqual(parseJson('[1, 2]'), { value: [1, 2] });
  });

  it('says so when there is no JSON at all', () => {
    assert.deepEqual(parseJson('I could not do that.'), { problem: 'the answer was not JSON' });
  });

  it('says so when the JSON is broken', () => {
    const got = parseJson('{"a": }');
    assert.ok('problem' in got && got.problem.startsWith('the answer was not valid JSON'));
  });
});

describe('checkSchema', () => {
  it('passes a well-formed quiz', () => {
    assert.equal(checkSchema({ title: 't', questions: [question(), question()] }, QUIZ), '');
  });

  it('names the missing key', () => {
    const problem = checkSchema({ questions: [question(), question()] }, QUIZ);
    assert.equal(problem, 'the result is missing the required key "title"');
  });

  it('names the path of a nested problem', () => {
    const problem = checkSchema({ title: 't', questions: [question(), question({ answer: 'two' })] }, QUIZ);
    assert.equal(problem, 'questions[1].answer should be an integer, got string');
  });

  it('counts a short array', () => {
    const problem = checkSchema({ title: 't', questions: [question()] }, QUIZ);
    assert.equal(problem, 'questions has 1 items, fewer than the 2 required');
  });

  it('lets an optional field be off its list - the reader drops it', () => {
    const schema = { type: 'object', required: ['type'], properties: { type: { type: 'string', enum: ['mcq'] }, importance: { type: 'string', enum: ['core', 'detail'] } } };
    assert.equal(checkSchema({ type: 'mcq', importance: 'medium' }, schema), '');
    assert.notEqual(checkSchema({ type: 'essay' }, schema), '');
  });

  it('rejects a required value outside its enum, and names it', () => {
    const schema = { type: 'object', required: ['level'], properties: { level: { type: 'string', enum: ['easy', 'hard'] } } };
    assert.equal(checkSchema({ level: 'brutal' }, schema), 'level is "brutal", which is not one of ["easy","hard"]');
  });

  it('lets a quiz question through with an optional difficulty off the list', () => {
    assert.equal(checkSchema({ title: 't', questions: [question({ difficulty: 'brutal' }), question()] }, QUIZ), '');
  });

  it('does not mistake an array or null for an object', () => {
    assert.equal(checkSchema([], QUIZ), 'the result should be an object, got array');
    assert.equal(checkSchema(null, QUIZ), 'the result should be an object, got null');
  });

  it('will not take a float where an integer was asked for', () => {
    const problem = checkSchema({ title: 't', questions: [question({ answer: 1.5 }), question()] }, QUIZ);
    assert.equal(problem, 'questions[0].answer should be an integer, got number');
  });

  it('reads a number and the same number as text as one answer', () => {
    assert.equal(checkSchema(2, { type: 'string' }), '');
    assert.equal(checkSchema('2', { type: 'integer' }), '');
    assert.equal(checkSchema('0.5', { type: 'number' }), '');
    assert.equal(checkSchema(true, { type: 'string', enum: ['true', 'false'] }), '');
    assert.equal(checkSchema({}, { type: 'string' }), 'the result should be a string, got object');
  });

  it('takes an integer where a number was asked for', () => {
    assert.equal(checkSchema(3, { type: 'number' }), '');
  });

  it('ignores keys the schema does not mention', () => {
    assert.equal(checkSchema({ title: 't', questions: [question(), question()], extra: 1 }, QUIZ), '');
  });
});

describe('fitsSchema', () => {
  it('parses and checks in one go', () => {
    const got = fitsSchema('{"title":"t","questions":[{"prompt":"p","choices":["a"],"answer":0},{"prompt":"q","choices":["b"],"answer":1}]}', QUIZ);
    assert.ok('value' in got);
  });

  it('reports the shape problem, not a parse problem, when the JSON is fine', () => {
    const got = fitsSchema('{"title":"t"}', QUIZ);
    assert.deepEqual(got, { problem: 'the result is missing the required key "questions"' });
  });
});
