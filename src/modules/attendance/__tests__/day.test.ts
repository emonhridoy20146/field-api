import { describe, expect, it } from 'vitest';
import { autoCloseAt, deriveDay, lateAbsences, type DayEvent, type DayInput } from '../domain/day.js';

// 2026-11-15, shift 09:00–18:00 Dhaka = 03:00–12:00 UTC
const t = (hhmm: string) => new Date(`2026-11-15T${hhmm}:00Z`);
const base = (events: DayEvent[], over: Partial<DayInput> = {}): DayInput => ({ events, shiftStart: t('03:00'), shiftEnd: t('12:00'), lateGraceMin: 15, maxBreakMin: 60, kind: 'working', now: t('13:00'), closed: true, ...over });
const ev = (id: string, type: DayEvent['type'], hhmm: string): DayEvent => ({ id, type, at: t(hhmm) });

describe('deriveDay', () => {
  it('a normal day: present, duty minus breaks', () => {
    const r = deriveDay(base([ev('1', 'work_in', '03:10'), ev('2', 'break_start', '07:00'), ev('3', 'break_end', '07:30'), ev('4', 'work_out', '12:10')]));
    expect(r).toMatchObject({ status: 'present', lateMin: 0, breakMin: 30, dutyMin: 510, overBreakMin: 0, flags: [] });
    expect(r.breaks).toHaveLength(1);
  });
  it('late only past the grace, and then counted from the shift start (ADR-043)', () => {
    const r = deriveDay(base([ev('1', 'work_in', '03:40'), ev('2', 'work_out', '12:00')]));
    expect(r.status).toBe('late');
    expect(r.lateMin).toBe(40); // shift 09:00 Dhaka, in at 09:40: 40 minutes, not 25
    // inside the grace (09:15 exactly) nobody is late
    const onTime = deriveDay(base([ev('1', 'work_in', '03:15'), ev('2', 'work_out', '12:00')]));
    expect(onTime).toMatchObject({ status: 'present', lateMin: 0 });
    // one minute past the grace: late by the whole 16 minutes
    expect(deriveDay(base([ev('1', 'work_in', '03:16'), ev('2', 'work_out', '12:00')])).lateMin).toBe(16);
  });
  it('invalid sequences are flagged and ignored, never rejected', () => {
    const r = deriveDay(base([ev('1', 'break_end', '03:00'), ev('2', 'work_in', '03:05'), ev('3', 'work_in', '03:06'), ev('4', 'work_out', '12:00')]));
    expect(r.invalidEventIds).toEqual(['1', '3']);
    expect(r.flags).toContain('invalid_sequence');
    expect(r.status).toBe('present');
  });
  it('events are ordered by time, not arrival (offline sync)', () => {
    const r = deriveDay(base([ev('b', 'work_out', '12:00'), ev('a', 'work_in', '03:00')]));
    expect(r.invalidEventIds).toEqual([]);
    expect(r.dutyMin).toBe(540);
  });
  it('over-break and leaving while on break', () => {
    const r = deriveDay(base([ev('1', 'work_in', '03:00'), ev('2', 'break_start', '06:00'), ev('3', 'work_out', '08:00')]));
    expect(r).toMatchObject({ breakMin: 120, overBreakMin: 60, dutyMin: 180 });
    expect(r.flags).toContain('over_break');
  });
  it('break inside the day\'s window is allowed on top of the limit (Friday 12:30–15:30, FR-ATT-010)', () => {
    // 12:30–15:30 Dhaka = 06:30–09:30 UTC
    const breakWindows = [{ start: t('06:30'), end: t('09:30') }];
    // the whole window taken: 180 minutes, nothing over
    const whole = deriveDay(base([ev('1', 'work_in', '03:00'), ev('2', 'break_start', '06:30'), ev('3', 'break_end', '09:30'), ev('4', 'work_out', '12:00')], { breakWindows }));
    expect(whole).toMatchObject({ breakMin: 180, windowBreakMin: 180, overBreakMin: 0, dutyMin: 360 });
    expect(whole.flags).not.toContain('over_break');
    // left 20 minutes early and came back 70 late: 90 outside the window, 30 over the 60-minute limit
    const long = deriveDay(base([ev('1', 'work_in', '03:00'), ev('2', 'break_start', '06:10'), ev('3', 'break_end', '10:40'), ev('4', 'work_out', '12:00')], { breakWindows }));
    expect(long).toMatchObject({ breakMin: 270, windowBreakMin: 180, overBreakMin: 30 });
    expect(long.flags).toContain('over_break');
    // a tea break in the morning and the window: both fine
    const two = deriveDay(base([ev('1', 'work_in', '03:00'), ev('2', 'break_start', '04:00'), ev('3', 'break_end', '04:20'), ev('4', 'break_start', '06:30'), ev('5', 'break_end', '09:30'), ev('6', 'work_out', '12:00')], { breakWindows }));
    expect(two).toMatchObject({ breakMin: 200, windowBreakMin: 180, overBreakMin: 0 });
    // without a window the same day is over the limit as before
    expect(deriveDay(base([ev('1', 'work_in', '03:00'), ev('2', 'break_start', '06:30'), ev('3', 'break_end', '09:30'), ev('4', 'work_out', '12:00')])).overBreakMin).toBe(120);
  });
  it('overtime: duty after the shift end, from the threshold; breaks are not overtime (FR-ATT-011)', () => {
    // out at 20:00 Dhaka (14:00 UTC): 120 minutes
    const late = deriveDay(base([ev('1', 'work_in', '03:00'), ev('2', 'work_out', '14:00')], { now: t('15:00'), overtimeAfterMin: 30 }));
    expect(late.overtimeMin).toBe(120);
    expect(late.flags).toContain('overtime');
    // 20 minutes past the end is under the 30-minute threshold
    const short = deriveDay(base([ev('1', 'work_in', '03:00'), ev('2', 'work_out', '12:20')], { overtimeAfterMin: 30 }));
    expect(short.overtimeMin).toBe(0);
    expect(short.flags).not.toContain('overtime');
    // a break after the shift end is taken off
    const withBreak = deriveDay(base([ev('1', 'work_in', '03:00'), ev('2', 'break_start', '12:30'), ev('3', 'break_end', '13:00'), ev('4', 'work_out', '14:00')], { now: t('15:00'), overtimeAfterMin: 30 }));
    expect(withBreak.overtimeMin).toBe(90);
    // coming late and leaving on time is not overtime
    expect(deriveDay(base([ev('1', 'work_in', '05:00'), ev('2', 'work_out', '12:00')])).overtimeMin).toBe(0);
  });
  it('overtime: a day the system closed has none; a weekly off day or holiday worked is all overtime; leave is not', () => {
    // forgot to press work-out: closed by the system 3 h after the shift end
    const auto = deriveDay(base([ev('1', 'work_in', '03:00'), ev('2', 'work_out', '15:00')], { now: t('16:00'), autoClosed: true }));
    expect(auto.overtimeMin).toBe(0);
    const off = deriveDay(base([ev('1', 'work_in', '04:00'), ev('2', 'break_start', '06:00'), ev('3', 'break_end', '06:30'), ev('4', 'work_out', '08:00')], { kind: 'weekly_off' }));
    expect(off).toMatchObject({ dutyMin: 210, overtimeMin: 210 });
    expect(off.flags).toEqual(expect.arrayContaining(['worked_on_off_day', 'overtime']));
    expect(deriveDay(base([ev('1', 'work_in', '04:00'), ev('2', 'work_out', '08:00')], { kind: 'holiday' })).overtimeMin).toBe(240);
    expect(deriveDay(base([ev('1', 'work_in', '04:00'), ev('2', 'work_out', '08:00')], { kind: 'leave' })).overtimeMin).toBe(0);
  });
  it('an open day shows overtime as it runs', () => {
    const r = deriveDay(base([ev('1', 'work_in', '03:00')], { now: t('13:00'), closed: false }));
    expect(r).toMatchObject({ status: 'on_duty', overtimeMin: 60 });
  });
  it('open day shows the live state and running totals', () => {
    const r = deriveDay(base([ev('1', 'work_in', '03:00'), ev('2', 'break_start', '05:00')], { now: t('05:20'), closed: false }));
    expect(r).toMatchObject({ status: 'on_break', breakMin: 20, dutyMin: 120 });
  });
  it('absent only after shift end on a working day; off days are not absences', () => {
    expect(deriveDay(base([], { now: t('05:00'), closed: false })).status).toBe('not_started');
    expect(deriveDay(base([], { now: t('12:00'), closed: false })).status).toBe('absent');
    expect(deriveDay(base([], { kind: 'holiday' })).status).toBe('holiday');
    expect(deriveDay(base([], { kind: 'weekly_off' })).status).toBe('weekly_off');
    expect(deriveDay(base([], { kind: 'leave' })).status).toBe('leave');
    expect(deriveDay(base([ev('1', 'work_in', '03:00'), ev('2', 'work_out', '06:00')], { kind: 'holiday' })).flags).toContain('worked_on_off_day');
  });
  it('auto close is 3 h after shift end', () => {
    expect(autoCloseAt(t('12:00'))).toEqual(t('15:00'));
  });
});

import { dutyIntervals, dutyStateAt } from '../domain/day.js';

describe('duty intervals (FR-LOC-001)', () => {
  const at = (hhmm: string) => new Date(`2026-11-15T${hhmm}:00+06:00`);
  const ev = (id: string, type: 'work_in' | 'break_start' | 'break_end' | 'work_out', hhmm: string) => ({ id, type, at: at(hhmm) });

  it('closed day with a break', () => {
    const i = dutyIntervals([ev('1', 'work_in', '09:00'), ev('2', 'break_start', '13:00'), ev('3', 'break_end', '13:30'), ev('4', 'work_out', '18:00')], at('21:00'));
    expect(dutyStateAt(i, at('08:59'))).toBe('off_duty');
    expect(dutyStateAt(i, at('10:00'))).toBe('on_duty');
    expect(dutyStateAt(i, at('13:10'))).toBe('on_break');
    expect(dutyStateAt(i, at('14:00'))).toBe('on_duty');
    expect(dutyStateAt(i, at('18:01'))).toBe('off_duty');
  });

  it('open day counts only until the cap; invalid events are ignored', () => {
    const i = dutyIntervals([ev('0', 'break_end', '08:00'), ev('1', 'work_in', '09:00')], at('21:00'));
    expect(dutyStateAt(i, at('20:59'))).toBe('on_duty');
    expect(dutyStateAt(i, at('21:01'))).toBe('off_duty');
    expect(dutyStateAt(i, at('08:30'))).toBe('off_duty');
  });

  it('second span the same day and leaving while on break', () => {
    const i = dutyIntervals([ev('1', 'work_in', '09:00'), ev('2', 'break_start', '12:00'), ev('3', 'work_out', '12:30'), ev('4', 'work_in', '16:00')], at('21:00'));
    expect(dutyStateAt(i, at('12:10'))).toBe('on_break');
    expect(dutyStateAt(i, at('14:00'))).toBe('off_duty');
    expect(dutyStateAt(i, at('17:00'))).toBe('on_duty');
  });
});

describe('lateAbsences (FR-ATT-012)', () => {
  it('every two late days of the month are one absent day; 0 turns the rule off', () => {
    expect([0, 1, 2, 3, 4, 5].map((n) => lateAbsences(n, 2))).toEqual([0, 0, 1, 1, 2, 2]);
    expect(lateAbsences(7, 3)).toBe(2);
    expect(lateAbsences(9, 0)).toBe(0);
    expect(lateAbsences(-1, 2)).toBe(0);
  });
});
