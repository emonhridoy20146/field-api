/** Pure track analysis: stops, gaps, daily summary (FR-LOC-007/008/012). No I/O. */
import { haversineM, type LatLng } from '../../../core/geo/index.js';

export interface TrackPoint extends LatLng {
  t: Date;
  mock?: boolean;
}

export interface DetectedStop {
  start: Date;
  end: Date;
  dwellMin: number;
  lat: number;
  lng: number;
  pointsCount: number;
}

/**
 * A stop is a run of consecutive points that all stay within `radiusM` of the run's first point
 * for at least `minDwellMin` (FR-LOC-008). The stop's position is the mean of its points.
 */
export function detectStops(points: TrackPoint[], radiusM: number, minDwellMin: number): DetectedStop[] {
  const stops: DetectedStop[] = [];
  let i = 0;
  while (i < points.length) {
    const anchor = points[i]!;
    let j = i;
    while (j + 1 < points.length && haversineM(anchor, points[j + 1]!) <= radiusM) j++;
    const dwellMs = points[j]!.t.getTime() - anchor.t.getTime();
    if (j > i && dwellMs >= minDwellMin * 60_000) {
      const run = points.slice(i, j + 1);
      stops.push({
        start: anchor.t,
        end: points[j]!.t,
        dwellMin: Math.round(dwellMs / 60_000),
        lat: run.reduce((s, p) => s + p.lat, 0) / run.length,
        lng: run.reduce((s, p) => s + p.lng, 0) / run.length,
        pointsCount: run.length,
      });
      i = j + 1;
    } else i++;
  }
  return stops;
}

export interface Segment {
  from: Date;
  to: Date;
  kind: 'moving' | 'gap';
}

/** Splits the day into stretches with data and gaps (no point for longer than `gapMin`), drawn dashed on the map. */
export function segments(points: TrackPoint[], gapMin: number): Segment[] {
  const out: Segment[] = [];
  if (points.length < 2) return out;
  let start = points[0]!.t;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!.t;
    const b = points[i]!.t;
    if (b.getTime() - a.getTime() > gapMin * 60_000) {
      if (a > start) out.push({ from: start, to: a, kind: 'moving' });
      out.push({ from: a, to: b, kind: 'gap' });
      start = b;
    }
  }
  const last = points[points.length - 1]!.t;
  if (last > start) out.push({ from: start, to: last, kind: 'moving' });
  return out;
}

export interface DailySummary {
  distanceKm: number;
  movingMin: number;
  stoppedMin: number;
  stopsCount: number;
  customerStops: number;
  gapsMin: number;
  mockPoints: number;
}

export function summarize(points: TrackPoint[], stops: { dwellMin: number; customerId?: string | null }[], gapMin: number): DailySummary {
  let meters = 0;
  let gapsMs = 0;
  for (let i = 1; i < points.length; i++) {
    const dt = points[i]!.t.getTime() - points[i - 1]!.t.getTime();
    // Distance across a gap is unknown; do not invent a straight line through it.
    if (dt > gapMin * 60_000) gapsMs += dt;
    else meters += haversineM(points[i - 1]!, points[i]!);
  }
  const totalMs = points.length > 1 ? points[points.length - 1]!.t.getTime() - points[0]!.t.getTime() : 0;
  const stoppedMin = stops.reduce((s, x) => s + x.dwellMin, 0);
  const gapsMin = Math.round(gapsMs / 60_000);
  return {
    distanceKm: Math.round(meters / 10) / 100,
    movingMin: Math.max(0, Math.round(totalMs / 60_000) - stoppedMin - gapsMin),
    stoppedMin,
    stopsCount: stops.length,
    customerStops: stops.filter((s) => !!s.customerId).length,
    gapsMin,
    mockPoints: points.filter((p) => p.mock).length,
  };
}

export type Freshness = 'fresh' | 'stale' | 'lost';
/** FR-LOC-006: fresh < 5 min, stale 5–30 min, lost > 30 min. */
export function freshness(ageMs: number): Freshness {
  if (ageMs < 5 * 60_000) return 'fresh';
  return ageMs <= 30 * 60_000 ? 'stale' : 'lost';
}
