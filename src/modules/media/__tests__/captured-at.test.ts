import { describe, expect, it } from 'vitest';
import { parseCapturedAt } from '../domain/captured-at.js';

describe('parseCapturedAt (1.45.0)', () => {
  it('reads UTC and offset values as given', () => {
    expect(parseCapturedAt('2026-11-23T10:12:05.000Z')?.toISOString()).toBe('2026-11-23T10:12:05.000Z');
    expect(parseCapturedAt('2026-11-23T16:12:05+06:00')?.toISOString()).toBe('2026-11-23T10:12:05.000Z');
  });
  it('reads a value without an offset (what the staff app sends) as Asia/Dhaka time', () => {
    expect(parseCapturedAt('2026-11-23T16:12:05.000')?.toISOString()).toBe('2026-11-23T10:12:05.000Z');
    // Dhaka 00:30 is 18:30 UTC of the day before
    expect(parseCapturedAt('2026-11-24T00:30')?.toISOString()).toBe('2026-11-23T18:30:00.000Z');
  });
  it('accepts Dart microseconds', () => {
    expect(parseCapturedAt('2026-11-23T10:12:05.123456Z')?.toISOString()).toBe('2026-11-23T10:12:05.123Z');
    expect(parseCapturedAt('2026-11-23T16:12:05.123456')?.toISOString()).toBe('2026-11-23T10:12:05.123Z');
  });
  it('refuses what is not a date-time', () => {
    for (const v of ['', 'yesterday', '2026-11-23', '2026-13-40T99:99:99Z', '1732350000']) expect(parseCapturedAt(v)).toBeNull();
  });
});
