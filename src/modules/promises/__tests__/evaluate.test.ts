import { describe, expect, it } from 'vitest';
import { dateInRange, isDue, verdict } from '../domain/evaluate.js';

describe('promise rules', () => {
  it('date must be today..+60 days', () => {
    expect(dateInRange('2026-11-15', '2026-11-15')).toBe(true);
    expect(dateInRange('2026-11-14', '2026-11-15')).toBe(false);
    expect(dateInRange('2027-01-14', '2026-11-15')).toBe(true);
    expect(dateInRange('2027-01-15', '2026-11-15')).toBe(false);
  });
  it('verdicts', () => {
    expect(verdict(500, 500)).toBe('kept');
    expect(verdict(100, 500)).toBe('partially_kept');
    expect(verdict(0, 500)).toBe('broken');
  });
  it('judged only after promised date + grace', () => {
    expect(isDue('2026-11-15', 1, '2026-11-16')).toBe(false);
    expect(isDue('2026-11-15', 1, '2026-11-17')).toBe(true);
    expect(isDue('2026-11-15', 0, '2026-11-16')).toBe(true);
  });
});
