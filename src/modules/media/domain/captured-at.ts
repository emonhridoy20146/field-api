/**
 * When a photo was taken, as the phone sends it (FR-MED-001). Times are UTC with `Z` or an offset in the contract, but
 * the staff app (≤ 1.45.0) sends a local DateTime read back from its database without either, e.g.
 * `2026-11-23T16:12:05.000`. The phones are in Bangladesh, so such a value is Asia/Dhaka wall-clock time (+06:00, no
 * daylight saving). Returns null for anything that is not an ISO-8601 date-time.
 */
const WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const NO_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?$/;

export function parseCapturedAt(value: string): Date | null {
  let iso: string;
  if (WITH_ZONE.test(value)) iso = value;
  else if (NO_ZONE.test(value)) iso = `${value}+06:00`;
  else return null;
  // Date.parse accepts at most milliseconds: Dart sends microseconds (`.123456`).
  const ms = Date.parse(iso.replace(/(\.\d{3})\d+/, '$1'));
  return Number.isNaN(ms) ? null : new Date(ms);
}
