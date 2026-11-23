import { describe, expect, it } from 'vitest';
import { cronMatches, latestSlot } from '../jobs/cron.js';

describe('latestSlot (1.45.0 catch-up for serverless cron calls)', () => {
  it('is the tick minute itself when it matches', () => {
    expect(latestSlot('*/2 * * * *', new Date('2026-11-23T04:10:30Z'), 10)?.toISOString()).toBe('2026-11-23T04:10:00.000Z');
  });
  it('finds the slot a late call missed', () => {
    // GitHub fires at :07 instead of :05; */2 → :06
    expect(latestSlot('*/2 * * * *', new Date('2026-11-23T04:07:12Z'), 10)?.toISOString()).toBe('2026-11-23T04:06:00.000Z');
    // daily 02:00 Dhaka = 20:00 UTC the day before, call at 02:13 Dhaka
    expect(latestSlot('0 2 * * *', new Date('2026-11-22T20:13:00Z'), 360)?.toISOString()).toBe('2026-11-22T20:00:00.000Z');
  });
  it('gives up outside the catch-up window', () => {
    expect(latestSlot('50 23 * * *', new Date('2026-11-23T18:05:00Z'), 9)).toBeNull(); // 00:05 Dhaka, too late for 23:50
    expect(latestSlot('50 23 * * *', new Date('2026-11-23T17:55:00Z'), 9)?.toISOString()).toBe('2026-11-23T17:50:00.000Z');
  });
  it('agrees with cronMatches across Dhaka midnight (18:00 UTC)', () => {
    for (const expr of ['5 0 * * *', '15 0 * * *', '*/15 * * * *', '5 0 * * 0-4']) {
      const at = new Date('2026-11-23T18:20:00Z'); // 00:20 Dhaka, Tuesday 24th
      const slot = latestSlot(expr, at, 60);
      expect(slot, expr).not.toBeNull();
      expect(cronMatches(expr, slot!), expr).toBe(true);
    }
  });
  it('rejects an invalid expression', () => {
    expect(() => latestSlot('* *', new Date(), 5)).toThrow();
  });
});
