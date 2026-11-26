import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, client, createTestApp, login, PASSWORD, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { mongoose } from '../../src/core/db/index.js';
import { createSystemUser, type UserView } from '../../src/modules/users/index.js';
import { clearSettingsCache } from '../../src/modules/settings/index.js';

/**
 * 1.51.0 (FR-AUTH-007, ADR-069, owner request 2026-11-26): in the staff app every role is device-bound except the
 * roles in `devices.multiDeviceRoles` (default super_admin). Web logins are never bound. A super admin on several
 * phones keeps a session and a tracking token per phone; logout on one phone ends only that phone's.
 */
let t: TestApp;
let s: Seeded;
let am: UserView;

beforeAll(async () => {
  t = await createTestApp();
  s = await seedBasics(t);
  am = await createSystemUser({ name: { en: 'Area M', bn: 'Area M' }, phone: '01700000071', role: 'area_manager', branchIds: [s.branchA], employeeCode: 'AM071', password: PASSWORD });
});
afterAll(async () => t.close());

const appLogin = (phone: string, deviceId: string) =>
  t.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-device-id': deviceId, 'x-client': 'staff-app/1.0.0 (android 10; Redmi 9A)', 'accept-language': 'en' },
    payload: { phone, password: PASSWORD, client: 'app' },
  });
const webLogin = (phone: string) => t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'accept-language': 'en' }, payload: { phone, password: PASSWORD, client: 'web' } });
const trackingRows = (userId: string) => mongoose.connection.db!.collection('tracking_tokens').find({ userId }).toArray();

async function setMultiDeviceRoles(roles: string[]) {
  const sa = await as(t, s.sa.phone, 'sa-settings');
  const r = await sa.patch('/settings', { changes: { 'devices.multiDeviceRoles': roles }, reason: 'device binding test' });
  expect(r.status).toBe(200);
  clearSettingsCache();
}

describe('who is device-bound in the app (ADR-069)', () => {
  it('the default setting is ["super_admin"] and the old devices.bindRoles is still readable', async () => {
    const sa = await as(t, s.sa.phone, 'sa-settings');
    const r = await sa.get('/settings');
    expect(r.status).toBe(200);
    expect(r.body['devices.multiDeviceRoles']).toEqual(['super_admin']);
    expect(r.body['devices.bindRoles']).toEqual(['field_staff']);
  });

  it('super admin: a second and a third phone log in without approval', async () => {
    for (const d of ['sa-phone-1', 'sa-phone-2', 'sa-phone-3']) expect((await appLogin(s.sa.phone, d)).statusCode).toBe(200);
  });

  it.each([
    ['area_manager', () => am.phone],
    ['branch_manager', () => s.bm.phone],
    ['viewer', () => s.vw.phone],
    ['field_staff', () => s.fs1.phone],
  ])('%s: the first phone binds, a second phone is 403 DEVICE_NOT_APPROVED (pending)', async (role, phone) => {
    expect((await appLogin(phone(), `${role}-phone-1`)).statusCode).toBe(200);
    const second = await appLogin(phone(), `${role}-phone-2`);
    expect(second.statusCode).toBe(403);
    expectConforms('POST', '/auth/login', 403, second.json());
    expect(second.json()).toMatchObject({ code: 'DEVICE_NOT_APPROVED', details: { deviceId: `${role}-phone-2`, status: 'pending_approval', maxActiveDevices: 1 } });
    // The bound phone still logs in.
    expect((await appLogin(phone(), `${role}-phone-1`)).statusCode).toBe(200);
  });

  it('web logins are never bound, for any role', async () => {
    for (const phone of [s.sa.phone, am.phone, s.bm.phone, s.vw.phone]) {
      expect((await webLogin(phone)).statusCode).toBe(200);
      expect((await webLogin(phone)).statusCode).toBe(200);
    }
  });

  it('a pending manager phone is approved with device.manage, as for field staff', async () => {
    const bm = await as(t, s.bm.phone, 'branch_manager-phone-1');
    const pending = (await bm.get(`/devices?userId=${s.vw.id}`)).body.find((d: { deviceId: string }) => d.deviceId === 'viewer-phone-2');
    expect(pending).toMatchObject({ status: 'pending_approval' });
    const vw = await as(t, s.vw.phone, 'viewer-phone-1');
    expect((await vw.post(`/devices/${pending.id}/approve`)).status).toBe(403);
    expect((await bm.post(`/devices/${pending.id}/approve`)).status).toBe(200);
    expect((await appLogin(s.vw.phone, 'viewer-phone-2')).statusCode).toBe(200);
    expect((await appLogin(s.vw.phone, 'viewer-phone-1')).statusCode).toBe(403);
  });

  it('a role listed in devices.multiDeviceRoles is not bound; an unknown role is refused', async () => {
    await setMultiDeviceRoles(['super_admin', 'branch_manager']);
    try {
      expect((await appLogin(s.bm.phone, 'branch_manager-phone-9')).statusCode).toBe(200);
    } finally {
      await setMultiDeviceRoles(['super_admin']);
    }
    const sa = await as(t, s.sa.phone, 'sa-settings');
    const bad = await sa.patch('/settings', { changes: { 'devices.multiDeviceRoles': ['owner'] }, reason: 'device binding test' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
  });
});

describe('a role that was not bound before deploy and already uses two phones', () => {
  it('the first phone it logs in with after the change keeps its place; the other phone is logged out and needs approval', async () => {
    const mgr = await createSystemUser({ name: { en: 'Old BM', bn: 'Old BM' }, phone: '01700000072', role: 'branch_manager', branchIds: [s.branchA], employeeCode: 'BM072', password: PASSWORD });
    // Before the change (old rule): branch managers unbound; both phones logged in and registered push tokens.
    await setMultiDeviceRoles(['super_admin', 'branch_manager']);
    const a = await login(t.app, mgr.phone, { deviceId: 'old-bm-A' });
    const b = await login(t.app, mgr.phone, { deviceId: 'old-bm-B' });
    const ca = client(t.app, a.accessToken, { 'x-device-id': 'old-bm-A' });
    const cb = client(t.app, b.accessToken, { 'x-device-id': 'old-bm-B' });
    expect((await ca.post('/devices/push-token', { deviceId: 'old-bm-A', fcmToken: 'f'.repeat(40) })).status).toBe(204);
    expect((await cb.post('/devices/push-token', { deviceId: 'old-bm-B', fcmToken: 'g'.repeat(40) })).status).toBe(204);
    const rows = await mongoose.connection.db!.collection('devices').find({ userId: mgr.id, status: 'active' }).toArray();
    expect(rows.map((r) => r.deviceId).sort()).toEqual(['old-bm-A', 'old-bm-B']);

    // Deploy: the default applies again.
    await setMultiDeviceRoles(['super_admin']);
    expect((await appLogin(mgr.phone, 'old-bm-A')).statusCode).toBe(200);
    expect((await cb.get('/auth/me')).status).toBe(401);
    const second = await appLogin(mgr.phone, 'old-bm-B');
    expect(second.statusCode).toBe(403);
    expect(second.json()).toMatchObject({ code: 'DEVICE_NOT_APPROVED', details: { deviceId: 'old-bm-B', status: 'pending_approval' } });
    const after = await mongoose.connection.db!.collection('devices').find({ userId: mgr.id }).toArray();
    expect(Object.fromEntries(after.map((r) => [r.deviceId, r.status]))).toEqual({ 'old-bm-A': 'active', 'old-bm-B': 'pending_approval' });
    const audit = await mongoose.connection.db!.collection('audit_logs').find({ action: 'device.unbound', entityId: 'old-bm-B' }).toArray();
    expect(audit.some((x) => x.reason === 'device_limit')).toBe(true);
  });
});

describe('super admin on two phones: sessions and tracking tokens are per phone', () => {
  it('rotation on one phone does not revoke the other phone; logout on one phone keeps the other logged in and tracking', async () => {
    const l1 = await login(t.app, s.sa.phone, { deviceId: 'sa-trk-1' });
    const l2 = await login(t.app, s.sa.phone, { deviceId: 'sa-trk-2' });
    const p1 = client(t.app, l1.accessToken, { 'x-device-id': 'sa-trk-1' });
    const p2 = client(t.app, l2.accessToken, { 'x-device-id': 'sa-trk-2' });
    const issue = async (c: typeof p1) => {
      const r = await c.post('/location/tracking-token');
      expect(r.status).toBe(200);
      return r.body.token as string;
    };
    await issue(p1);
    await issue(p2);
    await issue(p1); // rotation on phone 1
    const live = (rows: Awaited<ReturnType<typeof trackingRows>>, dev: string) => rows.filter((r) => r.deviceId === dev && !r.revokedAt);
    let rows = await trackingRows(s.sa.id);
    expect(live(rows, 'sa-trk-1')).toHaveLength(1);
    expect(live(rows, 'sa-trk-2')).toHaveLength(1);
    expect(rows.filter((r) => r.deviceId === 'sa-trk-2' && r.revokedAt)).toHaveLength(0);

    expect((await p1.post('/auth/logout')).status).toBe(204);
    expect((await p1.get('/auth/me')).status).toBe(401);
    expect((await p2.get('/auth/me')).status).toBe(200);
    rows = await trackingRows(s.sa.id);
    expect(live(rows, 'sa-trk-1')).toHaveLength(0);
    expect(live(rows, 'sa-trk-2')).toHaveLength(1);
    expect(rows.find((r) => r.deviceId === 'sa-trk-1' && r.revokedReason === 'logout')).toBeTruthy();
  });
});
