import { describe, expect, it } from 'vitest';
import { filterPoints, type FilterOptions } from '../domain/filter.js';
import { detectStops, freshness, segments, summarize } from '../domain/track.js';

const at = (hhmm: string, sec = 0) => new Date(`2026-11-15T${hhmm}:${String(sec).padStart(2, '0')}+06:00`);
const base = { lat: 22.7, lng: 90.37 };
// ~111 m per 0.001° of latitude
const north = (m: number) => ({ lat: base.lat + m / 111_320, lng: base.lng });
const opts = (over: Partial<FilterOptions> = {}): FilterOptions => ({ now: at('12:00'), maxAccuracyM: 50, maxSpeedKmh: 120, futureToleranceMs: 120_000, onDuty: () => true, known: [], previous: null, ...over });

describe('filterPoints (FR-LOC-003)', () => {
  it('keeps good points and explains each rejection by its original index', () => {
    const pts = [
      { t: at('10:00'), ...north(0), acc: 10 },
      { t: at('10:01'), ...north(200), acc: 6000 }, // beyond any use
      { t: at('10:01'), ...north(300), acc: 10 },
      { t: at('10:01'), ...north(300), acc: 10 }, // duplicate timestamp
      { t: at('10:02'), ...north(9000), acc: 10 }, // 8.7 km in a minute
      { t: at('10:03'), ...north(600), acc: 10 }, // judged against the last accepted point
      { t: at('12:05'), ...north(600), acc: 10 }, // future
    ];
    const r = filterPoints(pts, opts());
    expect(r.accepted.map((p) => p.t.toISOString())).toEqual([at('10:00'), at('10:01'), at('10:03')].map((d) => d.toISOString()));
    expect(r.rejected).toEqual([
      { index: 1, reason: 'LOW_ACCURACY' },
      { index: 3, reason: 'DUPLICATE' },
      { index: 4, reason: 'IMPOSSIBLE_SPEED' },
      { index: 6, reason: 'FUTURE_TIME' },
    ]);
  });

  it('refuses everything outside duty hours, sorts out-of-order input, uses stored state across batches', () => {
    const onDuty = (d: Date) => d >= at('09:00') && d <= at('18:00');
    const r = filterPoints([{ t: at('18:30'), ...north(0), acc: 5 }, { t: at('08:00'), ...north(0), acc: 5 }, { t: at('09:30'), ...north(0), acc: 5 }], opts({ now: at('19:00'), onDuty }));
    expect(r.accepted).toHaveLength(1);
    expect(r.rejected).toEqual([{ index: 0, reason: 'OFF_DUTY' }, { index: 1, reason: 'OFF_DUTY' }]);
    const again = filterPoints([{ t: at('09:30'), ...north(0), acc: 5 }, { t: at('09:31'), ...north(20_000), acc: 5 }], opts({ known: [{ t: at('09:30'), ...north(0), acc: 5 }], previous: { t: at('09:30'), ...north(0), acc: 5 } }));
    expect(again.rejected.map((x) => x.reason)).toEqual(['DUPLICATE', 'IMPOSSIBLE_SPEED']);
  });

  it('keeps rough points flagged for the live map; they never anchor the speed check; the better of two at one instant wins (ADR-041)', () => {
    const pts = [
      { t: at('10:00'), ...north(0), acc: 10 },
      { t: at('10:01'), ...north(400), acc: 300 }, // indoors: kept, flagged
      { t: at('10:01'), ...north(5), acc: 20 }, // same instant, more accurate: this one wins
      { t: at('10:02'), ...north(30), acc: 15 },
    ];
    const r = filterPoints(pts, opts());
    expect(r.accepted.map((p) => p.acc)).toEqual([10, 20, 15]);
    expect(r.rejected).toEqual([{ index: 1, reason: 'DUPLICATE' }]);
    const rough = filterPoints([{ t: at('10:05'), ...north(600), acc: 400 }, { t: at('10:05', 30), ...north(20), acc: 10 }], opts({ previous: { t: at('10:04'), ...north(0), acc: 10 } }));
    expect(rough.rejected).toEqual([]);
    expect([...rough.lowAccuracy].map((p) => p.acc)).toEqual([400]);
  });

  it('GPS jitter between fixes one second apart is not "impossible speed"', () => {
    const r = filterPoints([{ t: at('10:00', 0), ...north(0), acc: 20 }, { t: at('10:00', 1), ...north(35), acc: 20 }], opts());
    expect(r.rejected).toEqual([]);
  });
});

describe('stops, segments, summary (FR-LOC-007/008/012)', () => {
  const track = [
    { t: at('10:00'), ...north(0) },
    { t: at('10:02'), ...north(400) },
    { t: at('10:04'), ...north(800) }, // arrives
    { t: at('10:07'), ...north(810) },
    { t: at('10:10'), ...north(795), mock: true },
    { t: at('10:12'), ...north(805) }, // 8 min within 60 m
    { t: at('10:14'), ...north(1200) },
    { t: at('10:40'), ...north(1600) }, // 26 min gap
    { t: at('10:42'), ...north(2000) },
  ];

  it('detects a stop of at least the minimum dwell inside the radius', () => {
    const stops = detectStops(track, 60, 5);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.start).toEqual(at('10:04'));
    expect(stops[0]!.end).toEqual(at('10:12'));
    expect(stops[0]!.dwellMin).toBe(8);
    expect(stops[0]!.pointsCount).toBe(4);
    expect(detectStops(track, 60, 10)).toHaveLength(0);
    expect(detectStops([], 60, 5)).toEqual([]);
  });

  it('marks gaps and does not count distance across them', () => {
    const seg = segments(track, 10);
    expect(seg.map((s) => s.kind)).toEqual(['moving', 'gap', 'moving']);
    expect(seg[1]).toMatchObject({ from: at('10:14'), to: at('10:40') });
    const stops = detectStops(track, 60, 5).map((s) => ({ ...s, customerId: 'c1' }));
    const sum = summarize(track, stops, 10);
    expect(sum.gapsMin).toBe(26);
    expect(sum.stoppedMin).toBe(8);
    expect(sum.movingMin).toBe(42 - 26 - 8);
    expect(sum.stopsCount).toBe(1);
    expect(sum.customerStops).toBe(1);
    expect(sum.mockPoints).toBe(1);
    expect(sum.distanceKm).toBeGreaterThan(1.5); // 0→1200 m and 1600→2000 m plus jitter
    expect(sum.distanceKm).toBeLessThan(1.8); // the 400 m across the gap is not counted
    expect(summarize([], [], 10).distanceKm).toBe(0);
    expect(segments([track[0]!], 10)).toEqual([]);
  });

  it('freshness bands', () => {
    expect(freshness(4 * 60_000)).toBe('fresh');
    expect(freshness(5 * 60_000)).toBe('stale');
    expect(freshness(30 * 60_000)).toBe('stale');
    expect(freshness(31 * 60_000)).toBe('lost');
  });
});
