import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, client, createTestApp, PASSWORD, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { clearSettingsCache, setSystem } from '../../src/modules/settings/index.js';

/** FR-AUTH-007 device binding: approval, replacing the old phone, idempotent approve, reinstall hint (1.47.0). */
let t: TestApp;
let s: Seeded;
let requested = 0;

beforeAll(async () => {
  t = await createTestApp();
  s = await seedBasics(t);
  t.ctx.bus.on('device.approval_requested', async () => void requested++);
});
afterAll(async () => t.close());

const appLogin = (phone: string, deviceId: string, model = 'Redmi 9A') =>
  t.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-device-id': deviceId, 'x-client': `staff-app/1.0.0 (android 10; ${model})`, 'accept-language': 'en' },
    payload: { phone, password: PASSWORD, client: 'app' },
  });

describe('device binding (FR-AUTH-007)', () => {
  let oldToken = '';
  let pendingId = '';

  it('first device binds; a second device is 403 DEVICE_NOT_APPROVED with the pending id', async () => {
    const first = await appLogin(s.fs1.phone, 'phone-A');
    expect(first.statusCode).toBe(200);
    oldToken = first.json().accessToken;

    const second = await appLogin(s.fs1.phone, 'phone-B');
    expect(second.statusCode).toBe(403);
    const body = second.json();
    expectConforms('POST', '/auth/login', 403, body);
    expect(body.code).toBe('DEVICE_NOT_APPROVED');
    expect(body.requestId).toBeTruthy();
    expect(body.details).toMatchObject({ deviceId: 'phone-B', status: 'pending_approval', maxActiveDevices: 1 });
    pendingId = body.details.pendingDeviceId;
    expect(pendingId).toMatch(/^[0-9a-f]{24}$/);
    expect(requested).toBe(1);

    // Retrying the login keeps the same request and does not ask the managers again.
    const retry = await appLogin(s.fs1.phone, 'phone-B');
    expect(retry.json().details.pendingDeviceId).toBe(pendingId);
    expect(requested).toBe(1);
  });

  it('lists the pending device with likelyReinstall=false while the hint is off (default)', async () => {
    const bm = await as(t, s.bm.phone);
    const list = await bm.get(`/devices?userId=${s.fs1.id}`);
    expect(list.status).toBe(200);
    expectConforms('GET', '/devices', 200, list.body);
    const pending = list.body.find((d: { id: string }) => d.id === pendingId);
    expect(pending).toMatchObject({ status: 'pending_approval', likelyReinstall: false, model: 'Redmi 9A' });
    expect(list.body.find((d: { deviceId: string }) => d.deviceId === 'phone-A')).toMatchObject({ status: 'active', likelyReinstall: false });
  });

  it('likelyReinstall: same model and Android version, old phone idle for the set days', async () => {
    await setSystem('devices.reinstallHintIdleDays', 3);
    clearSettingsCache();
    try {
      const bmNow = await as(t, s.bm.phone);
      const pendingRow = async (c: typeof bmNow) => (await c.get(`/devices?userId=${s.fs1.id}`)).body.find((d: { id: string }) => d.id === pendingId);
      expect((await pendingRow(bmNow)).likelyReinstall).toBe(false); // phone-A was seen just now
      t.clock.advance(4 * 86400_000);
      const bm = await as(t, s.bm.phone);
      const list = await bm.get(`/devices?userId=${s.fs1.id}`);
      expectConforms('GET', '/devices', 200, list.body);
      expect((await pendingRow(bm)).likelyReinstall).toBe(true);
      // A different phone model is not a reinstall.
      expect((await appLogin(s.fs2.phone, 'fs2-phone-A')).statusCode).toBe(200);
      t.clock.advance(4 * 86400_000);
      expect((await appLogin(s.fs2.phone, 'fs2-phone-B', 'Galaxy A12')).statusCode).toBe(403);
      const bm2 = await as(t, s.bm.phone);
      const fs2Pending = (await bm2.get(`/devices?userId=${s.fs2.id}`)).body.find((d: { deviceId: string }) => d.deviceId === 'fs2-phone-B');
      expect(fs2Pending).toMatchObject({ status: 'pending_approval', likelyReinstall: false });
      // Nothing was approved by the hint.
      expect((await appLogin(s.fs1.phone, 'phone-B')).statusCode).toBe(403);
    } finally {
      await setSystem('devices.reinstallHintIdleDays', 0);
      clearSettingsCache();
    }
  });

  it('only device.manage may approve; out of scope is 404; no token is 401', async () => {
    const fs = await as(t, s.fs2.phone, 'fs2-phone-A');
    expect((await fs.post(`/devices/${pendingId}/approve`)).status).toBe(403);
    expect((await client(t.app).post(`/devices/${pendingId}/approve`)).status).toBe(401);
    // A branch-B manager: create one, then try.
    const sa = await as(t, s.sa.phone);
    const created = await sa.post('/users', { name: { en: 'Manager B' }, phone: '01800000077', role: 'branch_manager', branchIds: [s.branchB], employeeCode: 'BM077' });
    expect(created.status).toBe(201);
    const l = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { phone: '01800000077', password: created.body.temporaryPassword, client: 'web' } });
    const bmB = client(t.app, l.json().accessToken);
    await bmB.post('/auth/password/change', { currentPassword: created.body.temporaryPassword, newPassword: 'B-Manager-Pass-77' });
    const l2 = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { phone: '01800000077', password: 'B-Manager-Pass-77', client: 'web' } });
    expect((await client(t.app, l2.json().accessToken).post(`/devices/${pendingId}/approve`)).status).toBe(404);
    expect((await sa.post(`/devices/${'a'.repeat(24)}/approve`)).status).toBe(404);
  });

  it('approving unbinds the old phone, ends its sessions, and approving again changes nothing', async () => {
    const bm = await as(t, s.bm.phone);
    const ok = await bm.post(`/devices/${pendingId}/approve`);
    expect(ok.status).toBe(200);
    expectConforms('POST', `/devices/${pendingId}/approve`, 200, ok.body);
    expect(ok.body).toEqual({ id: pendingId, status: 'active' });

    const after = (await bm.get(`/devices?userId=${s.fs1.id}`)).body as { deviceId: string; status: string; id: string }[];
    expect(after.filter((d) => d.status === 'active').map((d) => d.deviceId)).toEqual(['phone-B']);
    const oldRow = after.find((d) => d.deviceId === 'phone-A')!;
    expect(oldRow.status).toBe('unbound');
    expect((await client(t.app, oldToken).get('/auth/me')).status).toBe(401);

    const again = await bm.post(`/devices/${pendingId}/approve`);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ id: pendingId, status: 'active' });
    const still = (await bm.get(`/devices?userId=${s.fs1.id}`)).body as { deviceId: string; status: string }[];
    expect(still.filter((d) => d.status === 'active').map((d) => d.deviceId)).toEqual(['phone-B']);

    // An unbound device cannot be approved (it must log in again and become pending).
    const unboundApprove = await bm.post(`/devices/${oldRow.id}/approve`);
    expect(unboundApprove.status).toBe(409);
    expect(unboundApprove.body.code).toBe('INVALID_STATE');

    // The new phone logs in; the old one now needs approval again.
    expect((await appLogin(s.fs1.phone, 'phone-B')).statusCode).toBe(200);
    expect((await appLogin(s.fs1.phone, 'phone-A')).statusCode).toBe(403);
  });

  it('two approvals at the same time bind once', async () => {
    const pending = await appLogin(s.fs2.phone, 'fs2-phone-B', 'Galaxy A12');
    const id = pending.json().details.pendingDeviceId as string;
    const bm = await as(t, s.bm.phone);
    const [a, b] = await Promise.all([bm.post(`/devices/${id}/approve`), bm.post(`/devices/${id}/approve`)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const rows = (await bm.get(`/devices?userId=${s.fs2.id}`)).body as { deviceId: string; status: string }[];
    expect(rows.filter((d) => d.status === 'active').map((d) => d.deviceId)).toEqual(['fs2-phone-B']);
  });
});
