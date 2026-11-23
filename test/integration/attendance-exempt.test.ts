import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, login, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { invalidatePermissions } from '../../src/modules/rbac/index.js';
import { attendanceRequired } from '../../src/modules/attendance/index.js';

// FR-ATT-014 (1.45.0): super admins (permission attendance.exempt) do not do attendance; the app is told so and they
// are never counted absent. Phones: SA 01700000001, BM 01700000002, FS1 01700000003, FS2 01700000004.
let t: TestApp;
let s: Seeded;
beforeAll(async () => {
  t = await createTestApp({ now: '2026-11-15T04:00:00Z' });
  s = await seedBasics(t, { flagsOn: true });
});
afterAll(async () => t.close());

describe('attendanceRequired', () => {
  it('is a pure permission rule', () => {
    expect(attendanceRequired(new Set(['attendance.record']), true)).toBe(true);
    expect(attendanceRequired(new Set(['attendance.record', 'attendance.exempt']), true)).toBe(false);
    expect(attendanceRequired(new Set(['attendance.record']), false)).toBe(false);
    expect(attendanceRequired(new Set([]), true)).toBe(false);
  });

  it('is false for the super admin and true for field staff on login, /auth/me and sync', async () => {
    const sa = await login(t.app, '01700000001', { client: 'web' });
    expect(sa.attendanceRequired).toBe(false);
    expect(sa.permissions).toContain('attendance.exempt');
    const fsLogin = await login(t.app, '01700000003');
    expect(fsLogin.attendanceRequired).toBe(true);
    expect(fsLogin.permissions).not.toContain('attendance.exempt');

    const fs = await as(t, '01700000003');
    const me = await fs.get('/auth/me');
    expect(me.body.attendanceRequired).toBe(true);
    expectConforms('GET', '/auth/me', 200, me.body);
    const boot = await fs.get('/sync/bootstrap?limit=1');
    expect(boot.status).toBe(200);
    expect(boot.body.attendanceRequired).toBe(true);
    expectConforms('GET', '/sync/bootstrap', 200, boot.body);
    const saMe = await (await as(t, '01700000001')).get('/auth/me');
    expect(saMe.body.attendanceRequired).toBe(false);
  });

  it('a field staff member made exempt disappears from the attendance days and is not counted absent', async () => {
    const bm = await as(t, '01700000002');
    const before = await bm.get('/attendance/days?from=2026-11-14&to=2026-11-14');
    expect(before.status).toBe(200);
    expect(before.body.some((d: { userId: string }) => d.userId === s.fs2.id)).toBe(true);

    const sa = await as(t, '01700000001');
    const r = await sa.put(`/rbac/overrides/user/${s.fs2.id}`, { changes: [{ key: 'attendance.exempt', effect: 'allow' }], reason: 'Office work, no attendance' });
    expect(r.status).toBe(200);
    invalidatePermissions();

    const after = await bm.get('/attendance/days?from=2026-11-14&to=2026-11-14');
    expect(after.body.some((d: { userId: string }) => d.userId === s.fs2.id)).toBe(false);
    expect(after.body.some((d: { userId: string }) => d.userId === s.fs1.id)).toBe(true);
    const dash = await bm.get('/dashboard/overview');
    expect(dash.status).toBe(200);
    const fs2 = await as(t, '01700000004');
    expect((await fs2.get('/auth/me')).body.attendanceRequired).toBe(false);
  });
});
