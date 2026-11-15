/** Pure attendance rules (FR-ATT-002..005). No I/O; times are Date (UTC), shift times are Dhaka HH:mm resolved by the caller. */

export type EventType = 'work_in' | 'break_start' | 'break_end' | 'work_out';
export interface DayEvent {
  id: string;
  type: EventType;
  at: Date;
}
export type LiveState = 'not_started' | 'on_duty' | 'on_break' | 'off_duty';
export type DayKind = 'working' | 'holiday' | 'weekly_off' | 'leave';
export type DayStatus = LiveState | 'present' | 'late' | 'absent' | 'leave' | 'holiday' | 'weekly_off';

/** Which event types are valid in each state (FR-ATT-002). */
const ALLOWED: Record<LiveState, EventType[]> = {
  not_started: ['work_in'],
  on_duty: ['break_start', 'work_out'],
  on_break: ['break_end', 'work_out'],
  off_duty: ['work_in'], // a second duty span on the same day (e.g. came back in the evening)
};
const NEXT: Record<EventType, LiveState> = { work_in: 'on_duty', break_start: 'on_break', break_end: 'on_duty', work_out: 'off_duty' };

export interface DayInput {
  events: DayEvent[];
  shiftStart: Date;
  shiftEnd: Date;
  lateGraceMin: number;
  maxBreakMin: number;
  kind: DayKind;
  /** "now" for an open day; duty/break minutes run up to here. */
  now: Date;
  /** true once the business date is over (or the day was auto-closed): live states become final ones. */
  closed: boolean;
}

export interface DayResult {
  status: DayStatus;
  state: LiveState;
  firstIn: Date | null;
  lastOut: Date | null;
  lateMin: number;
  breakMin: number;
  dutyMin: number;
  overBreakMin: number;
  breaks: { start: Date; end: Date | null }[];
  /** ids of events that did not fit the sequence: kept and flagged, never applied (anomalies are not rejected). */
  invalidEventIds: string[];
  flags: string[];
}

const min = (a: Date, b: Date) => Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));

export function deriveDay(i: DayInput): DayResult {
  const events = [...i.events].sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));
  let state: LiveState = 'not_started';
  let firstIn: Date | null = null;
  let lastOut: Date | null = null;
  let spanStart: Date | null = null;
  let breakStart: Date | null = null;
  let dutyMin = 0;
  let breakMin = 0;
  const breaks: DayResult['breaks'] = [];
  const invalid: string[] = [];
  for (const e of events) {
    if (!ALLOWED[state].includes(e.type)) {
      invalid.push(e.id);
      continue;
    }
    if (e.type === 'work_in') {
      firstIn ??= e.at;
      spanStart = e.at;
      lastOut = null;
    } else if (e.type === 'break_start') {
      breakStart = e.at;
      breaks.push({ start: e.at, end: null });
    } else if (e.type === 'break_end') {
      breakMin += min(breakStart!, e.at);
      breaks[breaks.length - 1]!.end = e.at;
      breakStart = null;
    } else {
      if (breakStart) {
        breakMin += min(breakStart, e.at); // left while on break: the break ends at work-out
        breaks[breaks.length - 1]!.end = e.at;
        breakStart = null;
      }
      dutyMin += min(spanStart!, e.at);
      spanStart = null;
      lastOut = e.at;
    }
    state = NEXT[e.type];
  }
  // Open span: count up to now so the app and dashboards show running totals.
  if (spanStart) dutyMin += min(spanStart, i.now);
  if (breakStart) breakMin += min(breakStart, i.now);
  dutyMin = Math.max(0, dutyMin - breakMin);

  const lateMin = firstIn ? Math.max(0, min(i.shiftStart, firstIn) - i.lateGraceMin) : 0;
  const flags: string[] = [];
  if (invalid.length) flags.push('invalid_sequence');
  const overBreakMin = Math.max(0, breakMin - i.maxBreakMin);
  if (overBreakMin > 0) flags.push('over_break');
  if (firstIn && i.kind !== 'working') flags.push('worked_on_off_day');

  let status: DayStatus;
  if (!firstIn) {
    if (i.kind !== 'working') status = i.kind;
    // Absent = no work-in on a working day by shift end (FR-ATT-003).
    else status = i.closed || i.now >= i.shiftEnd ? 'absent' : 'not_started';
  } else if (!i.closed) status = state;
  else status = lateMin > 0 ? 'late' : 'present';
  return { status, state, firstIn, lastOut, lateMin, breakMin, dutyMin, overBreakMin, breaks, invalidEventIds: invalid, flags };
}

/** FR-ATT-005: an open day is closed by the system 3 h after shift end. */
export const AUTO_CLOSE_AFTER_MIN = 180;
export function autoCloseAt(shiftEnd: Date): Date {
  return new Date(shiftEnd.getTime() + AUTO_CLOSE_AFTER_MIN * 60_000);
}
