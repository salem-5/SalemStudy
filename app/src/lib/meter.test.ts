import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { charge, createMeter, formatCost } from './meter.ts';

describe('what a piece of work cost', () => {
  it('adds up every call, and says so each time', () => {
    const seen: number[] = [];
    const m = createMeter((t) => seen.push(t));
    charge(m, { cost: 0.001 });
    charge(m, { cost: 0.002 });
    charge(m, {});
    charge(undefined, { cost: 5 });
    assert.ok(Math.abs(m.total - 0.003) < 1e-12);
    assert.equal(seen.length, 2);
  });

  it('ignores nonsense', () => {
    const m = createMeter();
    m.add(-1); m.add(Number.NaN); m.add(0);
    assert.equal(m.total, 0);
  });

  it('keeps fractions of a cent readable', () => {
    assert.equal(formatCost(0.00042), '$0.0004');
    assert.equal(formatCost(0.0234), '$0.023');
    assert.equal(formatCost(1.5), '$1.50');
    assert.equal(formatCost(0.00001), '<$0.0001');
    assert.equal(formatCost(null), '');
  });
});
