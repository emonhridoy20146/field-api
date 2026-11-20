import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { autoClose, finalize, isOnDuty } from '../../src/modules/attendance/service.js';
import { setSystem } from '../../src/modules/settings/index.js';
import { storage, type MemoryStorage } from '../../src/core/storage/index.js';

let t: TestApp;
let s: Seeded;
const geo = { lat: 22.7, lng: 90.37, accuracyM: 8 };
const ev = (type: string, at: string, extra: Record<string, unknown> = {}) => ({ clientId: randomUUID(), type, at, geo, ...extra });

beforeAll(async () => {
  t = await createTestApp(); // Sunday 2026-11-15 10:00 Dhaka; default shift 09:00–18:00, Friday off
  s = await seedBasics(t);
});
afterAll(async () => t.close());

describe('attendance events (FR-ATT-001..003)', () => {
  it('work-in late, break, idempotent replay, anomalies flagged not rejected', async () => {
    const fs = await as(t, '01700000003');
    const before = await fs.get('/attendance/me/today');
    expect(before.status).toBe(200);
    expectConforms('GET', '/attendance/me/today', 200, before.body);
    expect(before.body.status).toBe('not_started');

    const wi = ev('work_in', '2026-11-15T03:40:00Z'); // 09:40 Dhaka → late
    const r = await fs.post('/attendance/events', wi);
    expect(r.status).toBe(201);
    expectConforms('POST', '/attendance/events', 201, r.body);
    expect(r.body.status).toBe('on_duty');
    expect(r.body.lateMin).toBeGreaterThan(0);
    expect((await fs.post('/attendance/events', wi)).status).toBe(200); // replay
    expect(await isOnDuty(s.fs1.id, new Date('2026-11-15T03:50:00Z'))).toBe(true);
    expect(await isOnDuty(s.fs1.id, new Date('2026-11-15T03:30:00Z'))).toBe(false);

    // break_end without break_start: accepted, flagged, state unchanged
    const bad = await fs.post('/attendance/events', ev('break_end', '2026-11-15T03:45:00Z'));
    expect(bad.status).toBe(201);
    expect(bad.body.status).toBe('on_duty');
    expect(bad.body.flags).toContain('invalid_sequence');

    const nogeo = await fs.post('/attendance/events', { ...ev('break_start', '2026-11-15T03:50:00Z', { geoUnavailableReason: 'timeout' }), geo: null });
    expect(nogeo.body.status).toBe('on_break');
    expect(nogeo.body.flags).toContain('no_location');
    expect(await isOnDuty(s.fs1.id, new Date('2026-11-15T03:55:00Z'))).toBe(false);
    const be = await fs.post('/attendance/events', ev('break_end', '2026-11-15T04:00:00Z'));
    expect(be.body.breakMin).toBe(10);
    expect(be.body.breaks).toHaveLength(1);
  });

  it('validation, permissions and another user reusing a clientId', async () => {
    const fs = await as(t, '01700000003');
    expect((await fs.post('/attendance/events', { type: 'work_in' })).status).toBe(400);
    const bm = await as(t, '01700000002');
    expect((await bm.post('/attendance/events', ev('work_in', '2026-11-15T03:00:00Z'))).status).toBe(403);
    expect((await fs.get('/attendance/days?from=2026-11-15&to=2026-11-15')).status).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/attendance/me/today' })).statusCode).toBe(401);
    const shared = ev('work_in', '2026-11-15T03:00:00Z');
    const fs2 = await as(t, '01700000004');
    expect((await fs2.post('/attendance/events', shared)).status).toBe(201);
    expect((await fs.post('/attendance/events', shared)).status).toBeGreaterThanOrEqual(400);
  });
});

describe('photo at every attendance event (FR-ATT-001, OD-12)', () => {
  const upload = async (c: Awaited<ReturnType<typeof as>>, n: number) =>
    (await c.post('/media/upload-url', { kind: 'selfie', contentType: 'image/jpeg', sizeBytes: 40_000 + n, sha256: String(n).padStart(64, 'a'), capturedAt: '2026-11-15T03:59:00Z' })).body.mediaId as string;

  it('all four events expect a photo by default; a missing or foreign photo is flagged, never rejected', async () => {
    t.clock.set('2026-11-16T04:00:00Z'); // Monday, a fresh day for this block
    const fsB = await as(t, '01700000005');
    const cfg = await fsB.get('/sync/pull?cursor=s_0'); // app-facing settings travel with sync
    expect(cfg.body.settings['attendance.selfieRequired']).toBe(true);
    expect(cfg.body.settings['attendance.selfieEvents']).toEqual(['work_in', 'break_start', 'break_end', 'work_out']);

    const photo = await upload(fsB, 1);
    const withPhoto = await fsB.post('/attendance/events', ev('work_in', '2026-11-16T03:00:00Z', { selfieMediaId: photo }));
    expect(withPhoto.status).toBe(201);
    expect(withPhoto.body.flags).not.toContain('no_selfie');
    const noPhoto = await fsB.post('/attendance/events', ev('break_start', '2026-11-16T03:30:00Z'));
    expect(noPhoto.status).toBe(201); // attendance is never lost over a photo
    expect(noPhoto.body.status).toBe('on_break');
    expect(noPhoto.body.flags).toContain('no_selfie');
    const foreign = await upload(await as(t, '01700000004'), 2); // somebody else's upload
    const stolen = await fsB.post('/attendance/events', ev('break_end', '2026-11-16T03:40:00Z', { selfieMediaId: foreign }));
    expect(stolen.status).toBe(201);

    const sa = await as(t, '01700000001');
    const list = await sa.get(`/attendance/events?userId=${s.fsB.id}&date=2026-11-16`);
    expect(list.status).toBe(200);
    expectConforms('GET', '/attendance/events', 200, list.body);
    expect(list.body.map((e: { type: string; selfieMediaId: string | null; flags: string[] }) => [e.type, e.selfieMediaId, e.flags.includes('no_selfie')])).toEqual([
      ['work_in', photo, false],
      ['break_start', null, true],
      ['break_end', null, true],
    ]);
    // Once the upload is confirmed, the manager side can open the photo.
    (storage() as MemoryStorage).markUploaded(`selfie/${s.fsB.id}/${'1'.padStart(64, 'a')}.jpg`);
    expect((await fsB.post(`/media/${photo}/confirm`)).status).toBe(200);
    expect((await sa.get(`/media/${photo}/url`)).status).toBe(200);
    expect((await (await as(t, '01700000004')).get(`/media/${photo}/url`)).status).toBe(404); // not other staff
  });

  it('the setting narrows which events need a photo, per branch; the master switch turns it off', async () => {
    await setSystem('attendance.selfieEvents', ['work_in', 'work_out', 'lunch'], s.branchB); // unknown value ignored
    const fsB = await as(t, '01700000005');
    const again = await fsB.post('/attendance/events', ev('break_start', '2026-11-16T03:45:00Z'));
    expect(again.body.flags.filter((f: string) => f === 'no_selfie')).toHaveLength(1); // only the earlier events
    const sa = await as(t, '01700000001');
    const events = (await sa.get(`/attendance/events?userId=${s.fsB.id}&date=2026-11-16`)).body;
    expect(events[events.length - 1]).toMatchObject({ type: 'break_start', flags: [] });
    await setSystem('attendance.selfieRequired', false, s.branchB);
    await fsB.post('/attendance/events', ev('break_end', '2026-11-16T03:50:00Z'));
    const out = await fsB.post('/attendance/events', ev('work_out', '2026-11-16T03:55:00Z'));
    expect(out.body.status).toBe('off_duty');
    const after = (await sa.get(`/attendance/events?userId=${s.fsB.id}&date=2026-11-16`)).body;
    expect(after.slice(-2).map((e: { flags: string[] }) => e.flags)).toEqual([[], []]);
  });

  it('events list: scope, validation, permissions', async () => {
    const bm = await as(t, '01700000002');
    expect((await bm.get(`/attendance/events?userId=${s.fsB.id}&date=2026-11-16`)).status).toBe(404); // other branch
    expect((await bm.get(`/attendance/events?userId=${s.fs1.id}&date=16-11-2026`)).status).toBe(400);
    expect((await bm.get('/attendance/events?date=2026-11-16')).status).toBe(400);
    expect((await bm.get(`/attendance/events?userId=${s.fs1.id}&date=2026-11-15`)).status).toBe(200);
    expect((await (await as(t, '01700000003')).get(`/attendance/events?userId=${s.fs1.id}&date=2026-11-15`)).status).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/attendance/events?userId=${s.fs1.id}&date=2026-11-15` })).statusCode).toBe(401);
    t.clock.set('2026-11-15T04:00:00Z');
  });
});

describe('manager views, corrections, leave (FR-ATT-004/006/008)', () => {
  it('lists days in scope and summarises the month', async () => {
    const bm = await as(t, '01700000002');
    const d = await bm.get('/attendance/days?from=2026-11-14&to=2026-11-15');
    expect(d.status).toBe(200);
    expectConforms('GET', '/attendance/days', 200, d.body);
    const mine = d.body.filter((x: { userId: string }) => x.userId === s.fs1.id);
    expect(mine.map((x: { status: string }) => x.status)).toEqual(['absent', 'on_duty']);
    expect((await bm.get('/attendance/days?from=2026-01-01&to=2026-11-15')).status).toBe(400);
    const other = await bm.get(`/attendance/days?from=2026-11-15&to=2026-11-15&branchId=${'a'.repeat(24)}`);
    expect(other.body).toEqual([]);
    const sum = await bm.get('/attendance/summary?month=2026-11');
    expect(sum.status).toBe(200);
    const row = sum.body.items.find((x: { userId: string }) => x.userId === s.fs1.id);
    expect(row.present).toBe(1);
    expect(row.late).toBe(1);
    expect(row.weeklyOff).toBe(2); // Fridays 6 and 13 November
  });

  it('corrects with reason; original kept; audited; cannot be done by field staff', async () => {
    const bm = await as(t, '01700000002');
    const fs = await as(t, '01700000003');
    const body = { userId: s.fs1.id, businessDate: '2026-11-14', type: 'work_in', at: '2026-11-14T03:00:00Z', reason: 'Phone was dead, confirmed by call' };
    expect((await fs.post('/attendance/corrections', body)).status).toBe(403);
    expect((await bm.post('/attendance/corrections', { ...body, reason: 'x' })).status).toBe(400);
    expect((await bm.post('/attendance/corrections', { ...body, userId: 'a'.repeat(24) })).status).toBe(404);
    const r = await bm.post('/attendance/corrections', body);
    expect(r.status).toBe(201);
    expect(r.body.day.corrected).toBe(true);
    expect(r.body.day.firstIn).toBe('2026-11-14T03:00:00.000Z');
    const moved = await bm.post('/attendance/corrections', { ...body, at: '2026-11-14T03:10:00Z', replacesEventId: r.body.eventId });
    expect(moved.body.day.firstIn).toBe('2026-11-14T03:10:00.000Z');
    const { AttendanceEventModel } = await import('../../src/modules/attendance/models/attendance.model.js');
    expect(await AttendanceEventModel.countDocuments({ userId: s.fs1.id, businessDate: '2026-11-14' })).toBe(2); // original kept
    const { AuditLogModel } = await import('../../src/modules/audit/models/audit-log.model.js');
    expect(await AuditLogModel.countDocuments({ action: 'attendance.corrected' })).toBe(2);
  });

  it('leave: request, overlap, scope, approve counts in absence logic', async () => {
    const fs = await as(t, '01700000003');
    const bm = await as(t, '01700000002');
    const l = await fs.post('/leave-requests', { type: 'sick', from: '2026-11-12', to: '2026-11-12', reason: 'Fever' });
    expect(l.status).toBe(201);
    expect((await fs.post('/leave-requests', { type: 'sick', from: '2026-11-12', to: '2026-11-13' })).status).toBe(409);
    expect((await fs.post('/leave-requests', { type: 'sick', from: '2026-11-13', to: '2026-11-12' })).status).toBe(400);
    expect((await bm.post('/leave-requests', { type: 'sick', from: '2026-12-01', to: '2026-12-01' })).status).toBe(403);
    expect((await (await as(t, '01700000004')).get('/leave-requests')).body.items).toEqual([]);
    expect((await bm.get('/leave-requests?status=pending')).body.items).toHaveLength(1);
    expect((await fs.post(`/leave-requests/${l.body.id}/decision`, { decision: 'approve' })).status).toBe(403);
    expect((await bm.post(`/leave-requests/${'a'.repeat(24)}/decision`, { decision: 'approve' })).status).toBe(404);
    const ok = await bm.post(`/leave-requests/${l.body.id}/decision`, { decision: 'approve' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('approved');
    expect((await bm.post(`/leave-requests/${l.body.id}/decision`, { decision: 'approve' })).status).toBe(409);
    const d = await bm.get(`/attendance/days?from=2026-11-12&to=2026-11-12&userId=${s.fs1.id}`);
    expect(d.body[0].status).toBe('leave');
  });
});

describe('jobs (FR-ATT-005)', () => {
  it('auto-closes 3 h after shift end and finalizes absences across Dhaka midnight', async () => {
    t.clock.set('2026-11-15T14:59:00Z'); // 20:59 Dhaka
    expect(await autoClose()).toBe(0);
    t.clock.set('2026-11-15T15:01:00Z'); // 21:01 Dhaka
    expect(await autoClose()).toBe(2); // fs1 and fs2 both still open
    expect(await autoClose()).toBe(0);
    t.clock.set('2026-11-15T18:30:00Z'); // 00:30 Dhaka on the 16th
    const absent = await finalize();
    expect(absent).toBeGreaterThanOrEqual(0);
    const bm = await as(t, '01700000002');
    const d = await bm.get(`/attendance/days?from=2026-11-15&to=2026-11-16&userId=${s.fs1.id}`);
    expect(d.body[0].autoClosed).toBe(true);
    expect(d.body[0].lastOut).toBe('2026-11-15T15:00:00.000Z');
    expect(d.body[0].flags).toContain('auto_closed');
    expect(d.body[1].businessDate).toBe('2026-11-16');
    expect(d.body[1].status).toBe('not_started');
  });
});

describe('duty hours per branch, break windows, overtime, late absences (FR-ATT-010..012, contract 1.25.0)', () => {
  it('the default shift is validated; the Friday window is free break time; overtime and late absences reach the month', async () => {
    const sa = await as(t, '01700000001');
    const fsB = await as(t, '01700000005');
    const shift = { start: '09:00', end: '18:00', weeklyOff: [], lateGraceMin: 15, maxBreakMin: 60, breakWindows: [{ weekday: 5, start: '12:30', end: '15:30' }] };

    // a wrong value never reaches attendance
    const wrongOrder = await sa.patch('/settings', { branchId: s.branchB, changes: { 'attendance.defaultShift': { ...shift, start: '18:00', end: '09:00' } }, reason: 'wrong order' });
    expect(wrongOrder.status).toBe(400);
    const wrongWindow = await sa.patch('/settings', { branchId: s.branchB, changes: { 'attendance.defaultShift': { ...shift, breakWindows: [{ weekday: 5, start: '15:30', end: '12:30' }] } }, reason: 'wrong window' });
    expect(wrongWindow.status).toBe(400);
    expect(JSON.stringify(wrongWindow.body)).toContain('attendance.defaultShift.breakWindows.0.end');
    expect((await sa.patch('/settings', { branchId: s.branchB, changes: { 'attendance.defaultShift': 'nine to six' }, reason: 'not a shift' })).status).toBe(400);

    // branch B works every day and has the Friday break; branch A keeps the org default
    const saved = await sa.patch('/settings', { branchId: s.branchB, changes: { 'attendance.defaultShift': shift }, reason: 'Friday break, no weekly off day' });
    expect(saved.status).toBe(200);
    const mine = await fsB.get('/attendance/me/shift');
    expectConforms('GET', '/attendance/me/shift', 200, mine.body);
    expect(mine.body).toMatchObject({ id: 'default', weeklyOff: [], breakWindows: [{ weekday: 5, start: '12:30', end: '15:30' }] });
    expect((await (await as(t, '01700000003')).get('/attendance/me/shift')).body).toMatchObject({ weeklyOff: [5], breakWindows: [] });

    // Wednesday 18 and Thursday 19 November: late twice
    t.clock.set('2026-11-20T15:00:00Z'); // Friday 21:00 Dhaka
    for (const [inAt, outAt] of [
      ['2026-11-18T03:40:00Z', '2026-11-18T12:00:00Z'],
      ['2026-11-19T03:20:00Z', '2026-11-19T12:10:00Z'],
    ] as const) {
      expect((await fsB.post('/attendance/events', ev('work_in', inAt))).status).toBe(201);
      expect((await fsB.post('/attendance/events', ev('work_out', outAt))).status).toBe(201);
    }

    // Friday 20: the whole window as a break (12:30–15:30 Dhaka), out at 20:00 Dhaka
    await fsB.post('/attendance/events', ev('work_in', '2026-11-20T03:00:00Z'));
    await fsB.post('/attendance/events', ev('break_start', '2026-11-20T06:30:00Z'));
    await fsB.post('/attendance/events', ev('break_end', '2026-11-20T09:30:00Z'));
    const out = await fsB.post('/attendance/events', ev('work_out', '2026-11-20T14:00:00Z'));
    expect(out.status).toBe(201);
    expectConforms('POST', '/attendance/events', 201, out.body);
    expect(out.body).toMatchObject({ breakMin: 180, overBreakMin: 0, overtimeMin: 120, lateMin: 0 });
    expect(out.body.flags).toContain('overtime');
    expect(out.body.flags).not.toContain('over_break');

    const d = await sa.get(`/attendance/days?from=2026-11-18&to=2026-11-20&userId=${s.fsB.id}`);
    expectConforms('GET', '/attendance/days', 200, d.body);
    expect(d.body.map((x: { status: string; lateMin: number; overtimeMin: number }) => [x.status, x.lateMin, x.overtimeMin])).toEqual([
      ['late', 40, 0],
      ['late', 20, 0], // ten minutes past the end is under the 30-minute threshold
      ['off_duty', 0, 120],
    ]);

    const sum = await sa.get(`/attendance/summary?month=2026-11&branchId=${s.branchB}`);
    expect(sum.status).toBe(200);
    expectConforms('GET', '/attendance/summary', 200, sum.body);
    const row = sum.body.items.find((x: { userId: string }) => x.userId === s.fsB.id);
    // worked on the 16th (earlier in this file, on time), the 18th, 19th and 20th
    expect(row).toMatchObject({ present: 4, late: 2, lateAbsences: 1, overtimeMin: 120, overtimeDays: 1, offDaysWorked: 0, overBreakMin: 0, overBreakDays: 0, weeklyOff: 0 });

    // three late days per absent day: the same month has none
    await setSystem('attendance.lateDaysPerAbsent', 3);
    const again = await sa.get(`/attendance/summary?month=2026-11&branchId=${s.branchB}`);
    expect(again.body.items.find((x: { userId: string }) => x.userId === s.fsB.id).lateAbsences).toBe(0);
  });

  it('work on the weekly off day is overtime', async () => {
    // branch A: Friday is off. fs2 works Friday 20 November 10:00–14:00 Dhaka.
    const fs2 = await as(t, '01700000004');
    await fs2.post('/attendance/events', ev('work_in', '2026-11-20T04:00:00Z'));
    const out = await fs2.post('/attendance/events', ev('work_out', '2026-11-20T08:00:00Z'));
    expect(out.body).toMatchObject({ dutyMin: 240, overtimeMin: 240 });
    expect(out.body.flags).toEqual(expect.arrayContaining(['worked_on_off_day', 'overtime']));
    const bm = await as(t, '01700000002');
    const sum = await bm.get('/attendance/summary?month=2026-11');
    expect(sum.body.items.find((x: { userId: string }) => x.userId === s.fs2.id)).toMatchObject({ offDaysWorked: 1, overtimeMin: 240 });
  });
});
