/** FR-NOT-004: no push inside the quiet window (Dhaka wall clock), unless the type is critical. */
export interface QuietHours {
  start: string; // 'HH:mm'
  end: string;
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** `minuteOfDay` is the Dhaka minute of day (0..1439). A window may wrap midnight (21:00–08:00). */
export function isQuiet(minuteOfDay: number, q: QuietHours): boolean {
  const s = minutes(q.start);
  const e = minutes(q.end);
  if (s === e) return false;
  return s < e ? minuteOfDay >= s && minuteOfDay < e : minuteOfDay >= s || minuteOfDay < e;
}

export const shouldPush = (minuteOfDay: number, q: QuietHours, critical: boolean) => critical || !isQuiet(minuteOfDay, q);
