/** Pure helpers for the FR-DSH-002 dashboard statistics (Asia/Dhaka business dates as YYYY-MM-DD). No I/O. */
import { addDays, diffDays, isIsoDate } from '../../../core/time/index.js';

/** Longest `from`..`to` range, in days counted inclusively. */
export const MAX_RANGE_DAYS = 366;

export interface DashboardRange {
  from: string;
  to: string;
  days: number;
}

/** The list behind a dashboard number: GET /api/v1{path}?{query}. Query values are always strings. */
export interface DashboardLink {
  path: string;
  query: Record<string, string>;
}

export const monthStart = (date: string): string => `${date.slice(0, 7)}-01`;

/** First and last day of the calendar month before the month of `date`. */
export function previousMonth(date: string): { from: string; to: string } {
  const to = addDays(monthStart(date), -1);
  return { from: monthStart(to), to };
}

/**
 * The statistics range. Defaults: `to` = `date`, `from` = first day of the month of `to` (so without either it is
 * the month of `date` up to `date`). Returns the offending field when the range is not allowed.
 */
export function resolveRange(
  q: { from?: string | undefined; to?: string | undefined },
  date: string,
  today: string,
): DashboardRange | { invalid: 'from' | 'to'; message: string } {
  const to = q.to ?? date;
  // `to` first: the default `from` is derived from it.
  if (!isIsoDate(to) || to > today) return { invalid: 'to', message: 'today or earlier (YYYY-MM-DD)' };
  const from = q.from ?? monthStart(to);
  if (!isIsoDate(from)) return { invalid: 'from', message: 'a date (YYYY-MM-DD)' };
  if (from > to) return { invalid: 'from', message: 'on or before `to`' };
  const days = diffDays(from, to) + 1;
  if (days > MAX_RANGE_DAYS) return { invalid: 'from', message: `from..to must span at most ${MAX_RANGE_DAYS} days` };
  return { from, to, days };
}

/** Every date of [from, to] in order. */
export function datesOf(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** A link with the given query; undefined values are left out so the query only carries real filters. */
export function linkTo(path: string, query: Record<string, string | undefined>): DashboardLink {
  const q: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) if (v !== undefined) q[k] = v;
  return { path, query: q };
}

/** part ÷ whole with 2 decimals; null when nothing was decided. */
export function rate(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) / 100 : null;
}

/** The first `n` rows by `value` (largest first), ties by `key` so the order is stable. */
export function topBy<T>(rows: T[], value: (r: T) => number, key: (r: T) => string, n: number): T[] {
  return [...rows].sort((a, b) => value(b) - value(a) || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)).slice(0, n);
}
