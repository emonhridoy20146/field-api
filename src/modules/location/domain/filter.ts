/** Pure ingest rules (FR-LOC-001/003). No I/O. */
import { haversineM } from '../../../core/geo/index.js';

export interface RawPoint {
  t: Date;
  lat: number;
  lng: number;
  acc: number;
}
export type RejectReason = 'LOW_ACCURACY' | 'IMPOSSIBLE_SPEED' | 'FUTURE_TIME' | 'DUPLICATE' | 'OFF_DUTY';

/**
 * Points less accurate than `maxAccuracyM` are kept, flagged, for the live map only (ADR-041): indoors a phone often
 * reports 100–500 m, and dropping those left the map empty for staff on duty. Beyond this they are noise (a cell tower).
 */
export const HARD_MAX_ACCURACY_M = 5000;

export interface FilterOptions {
  now: Date;
  maxAccuracyM: number; // 50: above this a point is kept but flagged `lowAccuracy`
  maxSpeedKmh: number; // 120
  futureToleranceMs: number; // 2 min
  /** Is this instant inside duty hours (and, when breaks pause tracking, outside a break)? */
  onDuty: (at: Date) => boolean;
  /** Points already stored for this user in the batch's time range (duplicates, and speed against late uploads). */
  known: RawPoint[];
  /** Last accepted point before this batch, if any (speed check across batches). */
  previous: RawPoint | null;
}

export interface FilterResult<T extends RawPoint> {
  accepted: T[];
  /** The accepted points less accurate than `maxAccuracyM` (live map only, not the route). */
  lowAccuracy: Set<T>;
  rejected: { index: number; reason: RejectReason }[];
}

/**
 * Decides, oldest first, which points to keep. The speed check compares with the last *accepted*
 * point, so one GPS jump does not poison the points after it.
 */
export function filterPoints<T extends RawPoint>(points: T[], o: FilterOptions): FilterResult<T> {
  // Same instant twice: the more accurate one wins, the other is a duplicate.
  const order = points.map((p, index) => ({ p, index })).sort((a, b) => a.p.t.getTime() - b.p.t.getTime() || a.p.acc - b.p.acc || a.index - b.index);
  const accepted: T[] = [];
  const rejected: FilterResult<T>['rejected'] = [];
  const lowAccuracy = new Set<T>();
  const stored = [...o.known].sort((a, b) => a.t.getTime() - b.t.getTime());
  const seen = new Set(stored.map((k) => k.t.getTime()));
  let prev = o.previous;
  let k = 0;
  for (const { p, index } of order) {
    const ms = p.t.getTime();
    // A batch may arrive after newer points were stored: compare with the nearest earlier point, stored or just accepted.
    for (; k < stored.length && stored[k]!.t.getTime() < ms; k++) if (stored[k]!.acc <= o.maxAccuracyM && (!prev || stored[k]!.t.getTime() >= prev.t.getTime())) prev = stored[k]!;
    let reason: RejectReason | null = null;
    if (ms - o.now.getTime() > o.futureToleranceMs) reason = 'FUTURE_TIME';
    else if (!o.onDuty(p.t)) reason = 'OFF_DUTY';
    else if (p.acc > HARD_MAX_ACCURACY_M) reason = 'LOW_ACCURACY';
    else if (seen.has(ms)) reason = 'DUPLICATE';
    else if (prev && ms > prev.t.getTime()) {
      const hours = (ms - prev.t.getTime()) / 3_600_000;
      const km = haversineM(prev, p) / 1000;
      // Ignore the allowed GPS error when judging tiny time gaps, or two fixes one second apart look "impossible".
      const slackKm = (prev.acc + p.acc) / 1000;
      if (Math.max(0, km - slackKm) / hours > o.maxSpeedKmh) reason = 'IMPOSSIBLE_SPEED';
    }
    if (reason) {
      rejected.push({ index, reason });
      continue;
    }
    seen.add(ms);
    accepted.push(p);
    // A rough fix is kept for the live map but never becomes the reference for the speed check.
    if (p.acc > o.maxAccuracyM) lowAccuracy.add(p);
    else if (!prev || ms >= prev.t.getTime()) prev = p;
  }
  rejected.sort((a, b) => a.index - b.index);
  return { accepted, rejected, lowAccuracy };
}
