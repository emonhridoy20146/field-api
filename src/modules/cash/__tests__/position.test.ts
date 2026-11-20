import { describe, expect, it } from 'vitest';
import { inHandBreakdown, oldestUndeposited, onHand, stateOf } from '../domain/position.js';

describe('cash position', () => {
  it('on hand never negative', () => {
    expect(onHand(1000, 400)).toBe(600);
    expect(onHand(100, 400)).toBe(0);
  });
  it('states at 80 % and 100 %', () => {
    expect(stateOf(3_999_999, 5_000_000)).toBe('ok');
    expect(stateOf(4_000_000, 5_000_000)).toBe('warning');
    expect(stateOf(5_000_000, 5_000_000)).toBe('exceeded');
    expect(stateOf(9, 0)).toBe('ok');
  });
  it('cash in hand is what deposits have not covered, oldest paid off first (FR-CASH-007)', () => {
    const c = [
      { id: 'a', amountPoisha: 500 },
      { id: 'b', amountPoisha: 300 },
      { id: 'c', amountPoisha: 200 },
    ];
    expect(inHandBreakdown(c, 0).map((x) => [x.id, x.inHandPoisha])).toEqual([['a', 500], ['b', 300], ['c', 200]]);
    // 600 deposited: all of a, 100 of b
    expect(inHandBreakdown(c, 600).map((x) => [x.id, x.inHandPoisha])).toEqual([['b', 200], ['c', 200]]);
    expect(inHandBreakdown(c, 800).map((x) => [x.id, x.inHandPoisha])).toEqual([['c', 200]]);
    expect(inHandBreakdown(c, 1000)).toEqual([]);
    // more deposited than collected (a voided collection after a deposit): nothing in hand, never negative
    expect(inHandBreakdown(c, 5000)).toEqual([]);
    expect(inHandBreakdown(c, -1)).toHaveLength(3);
    // the parts always add up to the position
    for (const d of [0, 1, 499, 500, 501, 799, 999]) expect(inHandBreakdown(c, d).reduce((n, x) => n + x.inHandPoisha, 0)).toBe(onHand(1000, d));
  });
  it('FIFO oldest undeposited', () => {
    const c = [{ at: new Date('2026-11-13'), amountPoisha: 100 }, { at: new Date('2026-11-14'), amountPoisha: 100 }];
    expect(oldestUndeposited(c, 0)).toEqual(new Date('2026-11-13'));
    expect(oldestUndeposited(c, 150)).toEqual(new Date('2026-11-14'));
    expect(oldestUndeposited(c, 200)).toBeNull();
  });
});
