/** Pure period maths for reports (Asia/Dhaka business dates as YYYY-MM-DD strings). No I/O. */
import { addDays, diffDays, isIsoDate, weekday } from '../../../core/time/index.js';

export type Granularity = 'day' | 'week' | 'month';

export function isMonth(s: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

/** Last calendar day of a YYYY-MM month. */
export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return addDays(next, -1);
}

/**
 * Range of a staff-performance request. A running month ends today; a period that has not started
 * yet is not a valid request (returns null).
 */
export function reportRange(period: 'daily' | 'monthly', date: string, today: string): { from: string; to: string } | null {
  if (period === 'daily') return isIsoDate(date) && date <= today ? { from: date, to: date } : null;
  if (!isMonth(date)) return null;
  const from = `${date}-01`;
  if (from > today) return null;
  const end = monthEnd(date);
  return { from, to: end > today ? today : end };
}

/** The business week starts on Saturday (Friday is the weekly day off). */
export function weekStart(date: string): string {
  return addDays(date, -((weekday(date) + 1) % 7));
}

export function bucketOf(date: string, g: Granularity): string {
  return g === 'day' ? date : g === 'week' ? weekStart(date) : date.slice(0, 7);
}

/** Every bucket key touching [from, to], in order, so empty periods still appear in a trend. */
export function buckets(from: string, to: string, g: Granularity): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const k = bucketOf(d, g);
    if (out[out.length - 1] !== k) out.push(k);
  }
  return out;
}

export function validRange(from: string, to: string, today: string, maxDays: number): boolean {
  return isIsoDate(from) && isIsoDate(to) && from <= to && to <= today && diffDays(from, to) <= maxDays;
}
