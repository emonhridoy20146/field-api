import { describe, expect, it } from 'vitest';
import { autoCloseAt, deriveDay, type DayEvent, type DayInput } from '../domain/day.js';

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
  it('late counts minutes after grace', () => {
    const r = deriveDay(base([ev('1', 'work_in', '03:40'), ev('2', 'work_out', '12:00')]));
    expect(r.status).toBe('late');
    expect(r.lateMin).toBe(25);
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
