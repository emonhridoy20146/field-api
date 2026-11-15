import { describe, expect, it } from 'vitest';
import { oldestUndeposited, onHand, stateOf } from '../domain/position.js';

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
  it('FIFO oldest undeposited', () => {
    const c = [{ at: new Date('2026-11-13'), amountPoisha: 100 }, { at: new Date('2026-11-14'), amountPoisha: 100 }];
    expect(oldestUndeposited(c, 0)).toEqual(new Date('2026-11-13'));
    expect(oldestUndeposited(c, 150)).toEqual(new Date('2026-11-14'));
    expect(oldestUndeposited(c, 200)).toBeNull();
  });
});
