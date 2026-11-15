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

export function validateCron(expr: string): boolean {
  try {
    cronMatches(expr, new Date(0));
    return true;
  } catch {
    return false;
  }
}
