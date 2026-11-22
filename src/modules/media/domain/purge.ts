/**
 * Rules for deleting old photos (FR-MED-003). Pure: no database, no clock.
 */
export const PHOTO_KINDS = ['selfie', 'visit_photo', 'location_proof'] as const;
/** Proof of money handed over: only deleted when the admin ticks the box. */
export const MONEY_PROOF_KINDS = ['deposit_slip', 'refund_proof'] as const;
/** From this day of the month the admin panel suggests deleting the previous months. */
export const SUGGEST_FROM_DAY = 5;
/** Photos deleted per POST /media/purge call; the client calls again until nothing remains. */
export const PURGE_BATCH = 200;

export type DeleteScope = 'purge' | 'attendance_day';

export function purgeKinds(includeMoneyProofs: boolean): string[] {
  return includeMoneyProofs ? [...PHOTO_KINDS, ...MONEY_PROOF_KINDS] : [...PHOTO_KINDS];
}

/** The text the admin must type: `DELETE 2026-11`. Exact, case and spaces included. */
export const confirmTextFor = (before: string): string => `DELETE ${before}`;

export function isMonth(s: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(s)) return false;
  const m = Number(s.slice(5, 7));
  return m >= 1 && m <= 12;
}

/** `before` may be the current month (everything earlier) or an earlier month, never a later one. */
export function isPastOrCurrentMonth(before: string, todayDate: string): boolean {
  return isMonth(before) && before <= todayDate.slice(0, 7);
}

export function shouldSuggest(todayDate: string, count: number): boolean {
  return count > 0 && Number(todayDate.slice(8, 10)) >= SUGGEST_FROM_DAY;
}

export function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}
