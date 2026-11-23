import { dhakaParts } from '../time/index.js';

/**
 * Minimal 5-field cron matcher evaluated in Asia/Dhaka: minute hour day month weekday.
 * Supports `*`, `*\/n`, `a-b`, `a,b,c`. Enough for our schedules; swap for a library if needed.
 */
export function cronMatches(expr: string, at: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Invalid cron: ${expr}`);
  const p = dhakaParts(at);
  const values = [p.minute, p.hour, p.day, p.month, p.weekday];
  return fields.every((f, i) => fieldMatches(f, values[i]!));
}

function fieldMatches(field: string, v: number): boolean {
  return field.split(',').some((part) => {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? Number(stepStr) : 1;
    let lo: number, hi: number;
    if (range === '*') {
      lo = 0;
      hi = 59;
    } else if (range!.includes('-')) {
      [lo, hi] = range!.split('-').map(Number) as [number, number];
    } else {
      lo = hi = Number(range);
      if (stepStr) hi = 59;
    }
    return v >= lo && v <= hi && (v - lo) % step === 0;
  });
}

/** Asia/Dhaka is UTC+06:00 all year (no daylight saving since 2009), so slot search can use plain arithmetic. */
const DHAKA_OFFSET_MS = 6 * 3_600_000;
const MINUTE_MS = 60_000;

function fixedParts(ms: number) {
  const d = new Date(ms + DHAKA_OFFSET_MS);
  return [d.getUTCMinutes(), d.getUTCHours(), d.getUTCDate(), d.getUTCMonth() + 1, d.getUTCDay()];
}

/**
 * The most recent minute at or before `at` that matches `expr`, looking back at most `windowMin` minutes; null when
 * none. A serverless host only runs jobs when something calls /api/cron (ADR-034, 1.45.0), and those calls come every
 * few minutes and late, so a job is due when its latest slot has not run yet, not only in the exact minute.
 */
export function latestSlot(expr: string, at: Date, windowMin: number): Date | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Invalid cron: ${expr}`);
  const start = Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS;
  for (let i = 0; i <= windowMin; i++) {
    const ms = start - i * MINUTE_MS;
    const v = fixedParts(ms);
    if (fields.every((f, k) => fieldMatches(f, v[k]!))) return new Date(ms);
  }
  return null;
}

export function validateCron(expr: string): boolean {
  try {
    cronMatches(expr, new Date(0));
    return true;
  } catch {
    return false;
  }
}
