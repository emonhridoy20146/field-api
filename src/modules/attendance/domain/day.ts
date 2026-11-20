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
  /**
   * Break windows of this date (e.g. Friday 12:30–15:30, FR-ATT-010): break time inside a window is allowed on
   * top of `maxBreakMin` and never counts as over-break.
   */
  breakWindows?: { start: Date; end: Date }[];
  /** Work past the shift end counts as overtime only from this many minutes (FR-ATT-011); default 30. */
  overtimeAfterMin?: number;
  /** The system closed the day (FR-ATT-005): the real end is unknown, so no overtime after the shift end. */
  autoClosed?: boolean;
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
  /** Break minutes that fell inside a break window of the day. */
  windowBreakMin: number;
  /**
   * FR-ATT-011: on a working day, minutes on duty (breaks excluded) after the shift end; on a weekly off day or a
   * holiday, every minute worked.
   */
  overtimeMin: number;
  breaks: { start: Date; end: Date | null }[];
  /** ids of events that did not fit the sequence: kept and flagged, never applied (anomalies are not rejected). */
  invalidEventIds: string[];
  flags: string[];
}

const min = (a: Date, b: Date) => Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));
/** A few minutes past the shift end (closing the day, the last customer) are not overtime. */
export const DEFAULT_OVERTIME_AFTER_MIN = 30;
type Range = { start: Date; end: Date };
/** Minutes of `r` that lie inside `w`. */
const overlapMin = (r: Range, w: Range) => {
  const from = Math.max(r.start.getTime(), w.start.getTime());
  const to = Math.min(r.end.getTime(), w.end.getTime());
  return to > from ? Math.round((to - from) / 60_000) : 0;
};

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
  const spans: Range[] = [];
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
      spans.push({ start: spanStart!, end: e.at });
      spanStart = null;
      lastOut = e.at;
    }
    state = NEXT[e.type];
  }
  // Open span: count up to now so the app and dashboards show running totals.
  if (spanStart) dutyMin += min(spanStart, i.now);
  if (spanStart && i.now > spanStart) spans.push({ start: spanStart, end: i.now });
  if (breakStart) breakMin += min(breakStart, i.now);
  dutyMin = Math.max(0, dutyMin - breakMin);
  const breakRanges: Range[] = breaks.map((b) => ({ start: b.start, end: b.end ?? i.now })).filter((b) => b.end > b.start);

  // Late only when the work-in is past the grace; then the late time is counted from the shift start, not from
  // the end of the grace (owner rule 2026-11-21, ADR-043): shift 09:00, grace 15, in at 09:40 → 40 minutes late.
  const afterStart = firstIn ? min(i.shiftStart, firstIn) : 0;
  const lateMin = afterStart > i.lateGraceMin ? afterStart : 0;
  const flags: string[] = [];
  if (invalid.length) flags.push('invalid_sequence');
  // Break time inside a window of the day (Friday prayer and lunch) is allowed; only the rest is held against the limit.
  const windows = i.breakWindows ?? [];
  const windowBreakMin = Math.min(breakMin, breakRanges.reduce((n, b) => n + windows.reduce((m, w) => m + overlapMin(b, w), 0), 0));
  const overBreakMin = Math.max(0, breakMin - windowBreakMin - i.maxBreakMin);
  if (overBreakMin > 0) flags.push('over_break');
  if (firstIn && i.kind !== 'working') flags.push('worked_on_off_day');

  // Overtime (FR-ATT-011). Leave is not an off day: someone who works on approved leave is flagged above, not paid extra here.
  let overtimeMin = 0;
  if (i.kind === 'weekly_off' || i.kind === 'holiday') overtimeMin = dutyMin;
  else if (i.kind === 'working' && !i.autoClosed) {
    const after: Range = { start: i.shiftEnd, end: new Date(8.64e15) };
    const worked = spans.reduce((n, r) => n + overlapMin(r, after), 0) - breakRanges.reduce((n, b) => n + overlapMin(b, after), 0);
    overtimeMin = worked >= Math.max(1, i.overtimeAfterMin ?? DEFAULT_OVERTIME_AFTER_MIN) ? worked : 0;
  }
  if (overtimeMin > 0) flags.push('overtime');

  let status: DayStatus;
  if (!firstIn) {
    if (i.kind !== 'working') status = i.kind;
    // Absent = no work-in on a working day by shift end (FR-ATT-003).
    else status = i.closed || i.now >= i.shiftEnd ? 'absent' : 'not_started';
  } else if (!i.closed) status = state;
  else status = lateMin > 0 ? 'late' : 'present';
  return { status, state, firstIn, lastOut, lateMin, breakMin, dutyMin, overBreakMin, windowBreakMin, overtimeMin, breaks, invalidEventIds: invalid, flags };
}

/**
 * FR-ATT-012 (owner rule): every `perAbsent` late days of a month count as one absent day for pay; 0 turns the
 * rule off. Counted per month, not by neighbouring days.
 */
export function lateAbsences(lateDays: number, perAbsent: number): number {
  return perAbsent > 0 ? Math.floor(Math.max(0, lateDays) / perAbsent) : 0;
}

/** FR-ATT-005: an open day is closed by the system 3 h after shift end. */
export const AUTO_CLOSE_AFTER_MIN = 180;
export function autoCloseAt(shiftEnd: Date): Date {
  return new Date(shiftEnd.getTime() + AUTO_CLOSE_AFTER_MIN * 60_000);
}

export interface DutyIntervals {
  /** Work-in → work-out spans; an open span ends at `openUntil`. */
  duty: { start: Date; end: Date }[];
  breaks: { start: Date; end: Date }[];
}

/**
 * Time ranges in which the person was on duty / on break, from the same state machine as deriveDay
 * (invalid events are ignored). Used to refuse location points outside duty hours (FR-LOC-001).
 */
export function dutyIntervals(input: DayEvent[], openUntil: Date): DutyIntervals {
  const events = [...input].sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));
  const out: DutyIntervals = { duty: [], breaks: [] };
  let state: LiveState = 'not_started';
  let spanStart: Date | null = null;
  let breakStart: Date | null = null;
  for (const e of events) {
    if (!ALLOWED[state].includes(e.type)) continue;
    if (e.type === 'work_in') spanStart = e.at;
    else if (e.type === 'break_start') breakStart = e.at;
    else if (e.type === 'break_end') {
      out.breaks.push({ start: breakStart!, end: e.at });
      breakStart = null;
    } else {
      if (breakStart) out.breaks.push({ start: breakStart, end: e.at });
      breakStart = null;
      out.duty.push({ start: spanStart!, end: e.at });
      spanStart = null;
    }
    state = NEXT[e.type];
  }
  if (breakStart && openUntil > breakStart) out.breaks.push({ start: breakStart, end: openUntil });
  if (spanStart && openUntil > spanStart) out.duty.push({ start: spanStart, end: openUntil });
  return out;
}

export type DutyState = 'on_duty' | 'on_break' | 'off_duty';
export function dutyStateAt(i: DutyIntervals, at: Date): DutyState {
  const t = at.getTime();
  const within = (r: { start: Date; end: Date }) => t >= r.start.getTime() && t <= r.end.getTime();
  if (!i.duty.some(within)) return 'off_duty';
  return i.breaks.some(within) ? 'on_break' : 'on_duty';
}
