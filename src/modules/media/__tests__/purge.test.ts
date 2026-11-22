import { describe, expect, it } from 'vitest';
import { chunk, confirmTextFor, isMonth, isPastOrCurrentMonth, purgeKinds, shouldSuggest } from '../domain/purge.js';

describe('photo purge rules (FR-MED-003)', () => {
  it('money proofs only when asked; voice notes never', () => {
    expect(purgeKinds(false)).toEqual(['selfie', 'visit_photo', 'location_proof']);
    expect(purgeKinds(true)).toEqual(['selfie', 'visit_photo', 'location_proof', 'deposit_slip', 'refund_proof']);
    expect(purgeKinds(true)).not.toContain('voice_note');
  });

  it('the confirmation text is exact', () => {
    expect(confirmTextFor('2026-11')).toBe('DELETE 2026-11');
  });

  it('accepts the current or an earlier month, never a later one', () => {
    expect(isMonth('2026-13')).toBe(false);
    expect(isMonth('2026-1')).toBe(false);
    expect(isPastOrCurrentMonth('2026-11', '2026-11-22')).toBe(true);
    expect(isPastOrCurrentMonth('2025-12', '2026-11-22')).toBe(true);
    expect(isPastOrCurrentMonth('2026-12', '2026-11-22')).toBe(false);
  });

  it('suggests from the 5th of the month when there is something to delete', () => {
    expect(shouldSuggest('2026-11-04', 10)).toBe(false);
    expect(shouldSuggest('2026-11-05', 10)).toBe(true);
    expect(shouldSuggest('2026-11-30', 0)).toBe(false);
  });

  it('chunks', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });
});
