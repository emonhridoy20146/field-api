import { z } from 'zod';

/** Pure shapes of duty hours (FR-SET-003, FR-ATT-010). Times are Dhaka `HH:mm`; weekdays are 0 = Sunday … 6 = Saturday. */
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/**
 * A weekly break window (FR-ATT-010): on that weekday, break time between start and end is allowed on top of
 * `maxBreakMin`. Example: Friday 12:30–15:30 for prayer and lunch in branches without a weekly off day.
 */
export const breakWindowSchema = z
  .object({ weekday: z.number().int().min(0).max(6), start: hhmm, end: hhmm })
  .refine((w) => w.start < w.end, { message: 'start must be before end', path: ['end'] });
export type BreakWindow = z.infer<typeof breakWindowSchema>;

const hours = {
  start: hhmm,
  end: hhmm,
  /** May be empty: a branch that works every day and only has a longer Friday break. */
  weeklyOff: z.array(z.number().int().min(0).max(6)).max(7).default([5]),
  lateGraceMin: z.number().int().min(0).max(240).default(15),
  maxBreakMin: z.number().int().min(0).max(480).default(60),
  breakWindows: z.array(breakWindowSchema).max(14).default([]),
};

/** A named shift (`/shifts`). The start-before-end rule is checked by the service (it also applies to partial updates). */
export const shiftSchema = z.object({ name: z.string().min(1).max(100), ...hours });

/**
 * Value of the `attendance.defaultShift` setting, org-wide or per branch: the duty hours of everyone without a
 * named shift. Checked on every write since 1.25.0, so a bad value can no longer reach attendance.
 */
export const defaultShiftSchema = z
  .object(hours)
  .strict()
  .refine((s) => s.start < s.end, { message: 'start must be before end', path: ['end'] });

/** Stored values from before 1.25.0 have no windows; anything malformed is dropped rather than breaking a day. */
export function cleanWindows(raw: unknown): BreakWindow[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((w) => {
    const r = breakWindowSchema.safeParse(w);
    return r.success ? [r.data] : [];
  });
}
