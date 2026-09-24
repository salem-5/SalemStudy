import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computational, courseFlavour, flavourOf, guidance, pageByPageFor } from './subjects.ts';

describe('classifying a course', () => {
  it('recognises the sciences', () => {
    assert.equal(flavourOf('Calculus II'), 'stem');
    assert.equal(flavourOf('Linear Algebra'), 'stem');
    assert.equal(flavourOf('Physics I - Mechanics'), 'stem');
    assert.equal(flavourOf('Thermodynamics'), 'stem');
    assert.equal(flavourOf('Data Structures'), 'stem');
  });

  it('recognises the life sciences', () => {
    assert.equal(flavourOf('Biology 201'), 'life');
    assert.equal(flavourOf('Human Anatomy and Physiology'), 'life');
    assert.equal(flavourOf('Microbiology'), 'life');
    assert.equal(flavourOf('Pharmacology'), 'life');
  });

  it('puts biochemistry and organic chemistry with the life sciences', () => {
    assert.equal(flavourOf('Biochemistry'), 'life');
    assert.equal(flavourOf('Organic Chemistry'), 'life');
    assert.equal(flavourOf('General Chemistry'), 'stem');
  });

  it('recognises business', () => {
    assert.equal(flavourOf('Financial Accounting'), 'business');
    assert.equal(flavourOf('Microeconomics'), 'business');
    assert.equal(flavourOf('Marketing Management'), 'business');
  });

  it('reads "financial mathematics" as business, not maths', () => {
    assert.equal(flavourOf('Financial Mathematics'), 'business');
  });

  it('falls back rather than guessing', () => {
    assert.equal(flavourOf('History of Art'), 'general');
    assert.equal(flavourOf(''), 'general');
  });

  it('weights the course name over a stray word in the syllabus', () => {
    const ctx = {
      subject: 'Biology 201',
      notebook: 'Cell structure',
      courseContext: 'We will use some algebra when covering population growth.',
    };
    assert.equal(courseFlavour(ctx), 'life');
  });

  it('uses the syllabus when the name says nothing', () => {
    const ctx = { subject: 'BIO-201', notebook: 'Unit 3', courseContext: 'Anatomy and physiology of the cardiovascular system.' };
    assert.equal(courseFlavour(ctx), 'life');
  });
});

describe('what the classification changes', () => {
  it('only asks for Python where there is something to compute', () => {
    assert.equal(computational('stem'), true);
    assert.equal(computational('business'), true);
    assert.equal(computational('life'), false, 'biology questions must not be given invented calculations');
    assert.equal(computational('general'), false);
  });

  it('tells a life-science generator not to invent calculations', () => {
    assert.match(guidance('life'), /Do NOT invent calculations/);
  });

  it('tells a STEM generator that every numeric answer is checked', () => {
    assert.match(guidance('stem'), /check_code/);
  });

  it('gives every flavour something specific to say', () => {
    for (const f of ['stem', 'life', 'business', 'general'] as const) {
      assert.ok(guidance(f).length > 200, `${f} needs real guidance`);
    }
  });
});

describe('page by page, when the AI cannot be asked', () => {
  it('is on for memorisation-heavy life sciences and off for the rest', () => {
    assert.equal(pageByPageFor(flavourOf('Pharmacology 201')), true);
    assert.equal(pageByPageFor(flavourOf('Human Anatomy')), true);
    assert.equal(pageByPageFor(flavourOf('Clinical Pharmacy')), true);
    assert.equal(pageByPageFor(flavourOf('Calculus III')), false);
    assert.equal(pageByPageFor(flavourOf('Managerial Accounting')), false);
    assert.equal(pageByPageFor(flavourOf('Intro to Philosophy')), false);
  });
});
