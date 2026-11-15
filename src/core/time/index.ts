import { DateTime } from 'luxon';

export const BUSINESS_TZ = 'Asia/Dhaka';

/** Injectable clock. Domain code must use this instead of `new Date()` (CLAUDE.md §2.8). */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Mutable clock for tests and simulations. */
export class FixedClock implements Clock {
  private t: number;
  constructor(at: Date | string) {
    this.t = new Date(at).getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  set(at: Date | string): void {
    this.t = new Date(at).getTime();
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/** Dhaka calendar date (YYYY-MM-DD) of an instant. */
export function businessDate(at: Date): string {
  return DateTime.fromJSDate(at, { zone: BUSINESS_TZ }).toISODate()!;
}

/** Dhaka local time "HH:mm" on a business date → UTC instant. */
export function dhakaInstant(date: string, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return DateTime.fromISO(date, { zone: BUSINESS_TZ }).set({ hour: h ?? 0, minute: m ?? 0 }).toJSDate();
}

export function startOfBusinessDay(date: string): Date {
  return DateTime.fromISO(date, { zone: BUSINESS_TZ }).startOf('day').toJSDate();
}

export function endOfBusinessDay(date: string): Date {
  return DateTime.fromISO(date, { zone: BUSINESS_TZ }).endOf('day').toJSDate();
}

export function addDays(date: string, days: number): string {
  return DateTime.fromISO(date, { zone: BUSINESS_TZ }).plus({ days }).toISODate()!;
}

/** Whole days from a to b (b − a) for YYYY-MM-DD strings. */
export function diffDays(a: string, b: string): number {
  return Math.round(
    DateTime.fromISO(b, { zone: 'UTC' }).diff(DateTime.fromISO(a, { zone: 'UTC' }), 'days').days,
  );
}

/** 0 = Sunday … 6 = Saturday (Friday = 5, the default weekly off). */
export function weekday(date: string): number {
  return DateTime.fromISO(date, { zone: BUSINESS_TZ }).weekday % 7;
}

export function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid;
}

/** Minutes of the Dhaka wall clock for an instant, e.g. 09:30 → 570. */
export function dhakaMinuteOfDay(at: Date): number {
  const dt = DateTime.fromJSDate(at, { zone: BUSINESS_TZ });
  return dt.hour * 60 + dt.minute;
}

export function dhakaParts(at: Date): { minute: number; hour: number; day: number; month: number; weekday: number } {
  const dt = DateTime.fromJSDate(at, { zone: BUSINESS_TZ });
  return { minute: dt.minute, hour: dt.hour, day: dt.day, month: dt.month, weekday: dt.weekday % 7 };
}

export function yymmdd(date: string): string {
  return date.slice(2, 4) + date.slice(5, 7) + date.slice(8, 10);
}
