import { describe, expect, it } from 'vitest';
import { isQuiet, shouldPush } from '../domain/quiet-hours.js';

const q = { start: '21:00', end: '08:00' };
describe('quiet hours (FR-NOT-004)', () => {
  it('wraps midnight', () => {
    expect(isQuiet(21 * 60, q)).toBe(true);
    expect(isQuiet(0, q)).toBe(true);
    expect(isQuiet(7 * 60 + 59, q)).toBe(true);
    expect(isQuiet(8 * 60, q)).toBe(false);
    expect(isQuiet(20 * 60 + 59, q)).toBe(false);
  });
  it('same-day window and empty window', () => {
    expect(isQuiet(13 * 60, { start: '12:00', end: '14:00' })).toBe(true);
    expect(isQuiet(14 * 60, { start: '12:00', end: '14:00' })).toBe(false);
    expect(isQuiet(5, { start: '00:00', end: '00:00' })).toBe(false);
  });
  it('critical bypasses', () => {
    expect(shouldPush(23 * 60, q, false)).toBe(false);
    expect(shouldPush(23 * 60, q, true)).toBe(true);
    expect(shouldPush(10 * 60, q, false)).toBe(true);
  });
});
