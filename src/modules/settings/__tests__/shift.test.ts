import { describe, expect, it } from 'vitest';
import { cleanWindows, defaultShiftSchema, shiftSchema } from '../domain/shift.js';

describe('default shift value (FR-ATT-010)', () => {
  const ok = { start: '09:00', end: '18:00' };
  it('fills the defaults: Friday off, 15 minutes grace, 60 minutes break, no window', () => {
    expect(defaultShiftSchema.parse(ok)).toEqual({ start: '09:00', end: '18:00', weeklyOff: [5], lateGraceMin: 15, maxBreakMin: 60, breakWindows: [] });
  });
  it('a branch that works every day with the Friday break; a branch off on Saturday', () => {
    const friday = defaultShiftSchema.parse({ ...ok, weeklyOff: [], breakWindows: [{ weekday: 5, start: '12:30', end: '15:30' }] });
    expect(friday.weeklyOff).toEqual([]);
    expect(friday.breakWindows).toEqual([{ weekday: 5, start: '12:30', end: '15:30' }]);
    expect(defaultShiftSchema.parse({ ...ok, weeklyOff: [6] }).weeklyOff).toEqual([6]);
  });
  it('refuses a wrong order, a bad time, a bad weekday, a window that ends before it starts and unknown keys', () => {
    const accepts = (v: unknown) => defaultShiftSchema.safeParse(v).success;
    expect(accepts({ start: '18:00', end: '09:00' })).toBe(false);
    expect(accepts({ start: '9:00', end: '18:00' })).toBe(false);
    expect(accepts({ ...ok, weeklyOff: [7] })).toBe(false);
    expect(accepts({ ...ok, breakWindows: [{ weekday: 5, start: '15:30', end: '12:30' }] })).toBe(false);
    expect(accepts({ ...ok, breakWindows: [{ weekday: 9, start: '12:30', end: '15:30' }] })).toBe(false);
    expect(accepts({ ...ok, salary: 1 })).toBe(false);
    expect(accepts('09:00-18:00')).toBe(false);
  });
  it('names the wrong part', () => {
    const r = defaultShiftSchema.safeParse({ ...ok, breakWindows: [{ weekday: 5, start: '15:30', end: '12:30' }] });
    expect(r.success ? [] : r.error.issues[0]?.path).toEqual(['breakWindows', 0, 'end']);
  });
});

describe('named shift and stored windows', () => {
  it('a named shift takes windows too', () => {
    expect(shiftSchema.parse({ name: 'Morning', start: '08:00', end: '16:00', breakWindows: [{ weekday: 5, start: '12:30', end: '15:30' }] }).breakWindows).toHaveLength(1);
  });
  it('values stored before 1.25.0 read as no window; a malformed window is dropped', () => {
    expect(cleanWindows(undefined)).toEqual([]);
    expect(cleanWindows('x')).toEqual([]);
    expect(cleanWindows([{ weekday: 5, start: '12:30', end: '15:30' }, { weekday: 5, start: 'noon', end: '15:30' }, null])).toEqual([{ weekday: 5, start: '12:30', end: '15:30' }]);
  });
});
