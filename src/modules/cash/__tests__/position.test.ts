import { describe, expect, it } from 'vitest';
import { depositCoverage, inHandBreakdown, oldestUndeposited, onHand, stateOf } from '../domain/position.js';

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

describe('which collections a deposit covered (FR-CASH-008)', () => {
  const c = [
    { id: 'a', amountPoisha: 500 },
    { id: 'b', amountPoisha: 300 },
    { id: 'c', amountPoisha: 200 },
  ];
  const deps = [
    { id: 'd1', amountPoisha: 600 },
    { id: 'd2', amountPoisha: 300 },
  ];
  const rows = (r: ReturnType<typeof depositCoverage<{ id: string; amountPoisha: number }>>) => r!.items.map((x) => [x.id, x.coveredPoisha]);

  it('the first deposit takes the oldest collections, the last one only in part', () => {
    const r = depositCoverage(c, deps, 'd1')!;
    expect(rows(r)).toEqual([['a', 500], ['b', 100]]);
    expect(r).toMatchObject({ coveredPoisha: 600, unmatchedPoisha: 0 });
  });

  it('the next deposit continues where the one before stopped', () => {
    const r = depositCoverage(c, deps, 'd2')!;
    expect(rows(r)).toEqual([['b', 200], ['c', 100]]);
    expect(r.coveredPoisha).toBe(300);
  });

  it('the deposits and the cash in hand split every collection with nothing lost or counted twice', () => {
    const covered = new Map<string, number>();
    for (const d of deps) for (const x of depositCoverage(c, deps, d.id)!.items) covered.set(x.id, (covered.get(x.id) ?? 0) + x.coveredPoisha);
    const inHand = new Map(inHandBreakdown(c, 900).map((x) => [x.id, x.inHandPoisha]));
    for (const x of c) expect((covered.get(x.id) ?? 0) + (inHand.get(x.id) ?? 0)).toBe(x.amountPoisha);
  });

  it('a deposit larger than what is left is unmatched for the rest; an unknown deposit is null', () => {
    const r = depositCoverage(c, [...deps, { id: 'd3', amountPoisha: 250 }], 'd3')!;
    expect(rows(r)).toEqual([['c', 100]]);
    expect(r).toMatchObject({ coveredPoisha: 100, unmatchedPoisha: 150 });
    expect(depositCoverage(c, deps, 'nope')).toBeNull();
    expect(depositCoverage([], deps, 'd1')).toEqual({ items: [], coveredPoisha: 0, unmatchedPoisha: 600 });
  });
});
