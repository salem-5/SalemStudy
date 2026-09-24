import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import katex from 'katex';
import { asMath, repairTex } from './mathText.ts';

const typesets = (tex: string) => {
  try { katex.renderToString(repairTex(tex), { throwOnError: true, strict: 'ignore' }); return true; } catch { return false; }
};

describe('maths as models write it', () => {
  it('draws a gap inside the maths as a line instead of failing', () => {
    assert.ok(typesets('(0, 0, _____)'));
    assert.ok(typesets('\\mathrm{comp}_{\\mathbf{a}}\\mathbf{b} = \\frac{\\mathbf{a}\\cdot\\mathbf{b}}{_____}'));
    assert.ok(typesets('\\overrightarrow{AB}=\\langle x_2-x_1,\;y_2-y_1,\;\\text{_____}\\rangle'));
    assert.ok(typesets('\\dfrac{\\mathbf{a}\\cdot\\mathbf{b}}{|\\mathbf{a}|^2}\\,_____'));
  });

  it('leaves ordinary subscripts alone', () => {
    assert.equal(repairTex('x_1 + x_{2}'), 'x_1 + x_{2}');
  });

  it('typesets an answer written as bare LaTeX', () => {
    assert.equal(asMath('-\\mathbf{b}'), '$-\\mathbf{b}$');
    assert.equal(asMath('$x^2$'), '$x^2$');
    assert.equal(asMath('Paget sarcoma'), 'Paget sarcoma');
  });
});
