import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, client, createTestApp, login, PASSWORD, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { collectRoutes } from '../../scripts/lib/routes.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { getByErpId } from '../../src/modules/customers/index.js';
import { invalidatePermissions } from '../../src/modules/rbac/index.js';
import { manifests } from '../../src/app/register-modules.js';

/** Role `area_manager` (1.48.0, ADR-065): every branch, most of the work, no user/role/password/flag/settings management. */
let t: TestApp;
let s: Seeded;
let amId: string;
const SA = '01700000001';
const BM = '01700000002';
const AM = '01700000017';
const web = async (phone: string) => client(t.app, (await login(t.app, phone, { client: 'web', deviceId: `web-${phone}` })).accessToken);

/** The catalog column: what an area manager holds with no overrides. */
const amDefaults = new Set(manifests.flatMap((m) => m.permissions).filter((p) => p.defaults.area_manager && !p.reserved).map((p) => p.key));

beforeAll(async () => {
  t = await createTestApp();
  s = await seedBasics(t);
  await deltaSync();
});
afterAll(async () => t.close());

describe('creating an area manager (users API)', () => {
  it('the super admin creates one; branchIds is the home branch only', async () => {
    const sa = await web(SA);
    const r = await sa.post('/users', { name: { en: 'Area Manager', bn: 'এরিয়া ম্যানেজার' }, phone: AM, role: 'area_manager', branchIds: [s.branchA], employeeCode: 'AM001' });
    expect(r.status).toBe(201);
    expectConforms('POST', '/users', 201, r.body);
    expect(r.body.user).toMatchObject({ role: 'area_manager', branchIds: [s.branchA], mustChangePassword: true });
    amId = r.body.user.id;
    // First login must change the temporary password; then it is an ordinary account.
    const l = await login(t.app, AM, { client: 'web', password: r.body.temporaryPassword });
    const self = client(t.app, l.accessToken);
    expect((await self.post('/auth/password/change', { currentPassword: r.body.temporaryPassword, newPassword: PASSWORD })).status).toBe(204);
    // The role filter knows the new role.
    const list = await sa.get('/users?role=area_manager');
    expect(list.status).toBe(200);
    expectConforms('GET', '/users', 200, list.body);
    expect(list.body.items.map((u: { id: string }) => u.id)).toEqual([amId]);
  });

  it('the super admin can also turn an existing user into an area manager and back', async () => {
    const sa = await web(SA);
    const vw = await sa.patch(`/users/${s.vw.id}`, { role: 'area_manager', reason: 'promoted' });
    expect(vw.status).toBe(200);
    expectConforms('PATCH', `/users/${s.vw.id}`, 200, vw.body);
    expect(vw.body.role).toBe('area_manager');
    expect((await sa.patch(`/users/${s.vw.id}`, { role: 'viewer', reason: 'back' })).body.role).toBe('viewer');
  });
});

describe('what an area manager may not do', () => {
  it('403 on user create, edit, role change, password reset, deactivate', async () => {
    const am = await web(AM);
    const calls = [
      am.post('/users', { name: { en: 'X' }, phone: '01799999999', role: 'field_staff', branchIds: [s.branchA], employeeCode: 'FS999' }),
      am.patch(`/users/${s.fs1.id}`, { name: { en: 'Renamed' } }),
      am.patch(`/users/${s.fs1.id}`, { role: 'branch_manager' }),
      am.patch(`/users/${amId}`, { role: 'super_admin' }),
      am.post(`/users/${s.fs1.id}/reset-password`),
      am.post(`/users/${s.fs1.id}/deactivate`, { reason: 'not allowed' }),
    ];
    for (const r of await Promise.all(calls)) {
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ code: 'FORBIDDEN', details: { permission: 'user.manage' } });
    }
    expectConforms('POST', '/users', 403, (await calls[0]!).body);
    expectConforms('PATCH', `/users/${s.fs1.id}`, 403, (await calls[1]!).body);
    expectConforms('POST', `/users/${s.fs1.id}/reset-password`, 403, (await calls[4]!).body);
  });

  it('403 on feature flags, system settings and permission overrides', async () => {
    const am = await web(AM);
    expect((await am.get('/feature-flags')).body.details.permission).toBe('flag.manage');
    expect((await am.put('/feature-flags/module.tasks', { defaultEnabled: false, reason: 'nope nope' })).status).toBe(403);
    expect((await am.patch('/settings', { changes: { 'cash.limitMode': 'warn' }, reason: 'nope nope' })).body.details.permission).toBe('settings.manage');
    expect((await am.put(`/rbac/overrides/user/${s.fs1.id}`, { changes: [{ key: 'tag.set', effect: 'deny' }], reason: 'nope nope' })).body.details.permission).toBe('rbac.manage');
  });

  it('no override can give an area manager user, role, flag or settings management', async () => {
    const sa = await web(SA);
    for (const key of ['user.manage', 'rbac.manage', 'flag.manage', 'settings.manage']) {
      const user = await sa.put(`/rbac/overrides/user/${amId}`, { changes: [{ key, effect: 'allow' }], reason: 'try to grant' });
      expect(user.status, key).toBe(422);
      expect(user.body.details).toMatchObject({ rule: 'PERMISSION_NOT_GRANTABLE', key, role: 'area_manager' });
      const branch = await sa.put(`/rbac/overrides/branch/${s.branchA}`, { role: 'area_manager', changes: [{ key, effect: 'allow' }], reason: 'try to grant' });
      expect(branch.status, key).toBe(422);
    }
    // A deny is fine (it changes nothing), and other keys can still be tuned per area manager.
    expect((await sa.put(`/rbac/overrides/user/${amId}`, { changes: [{ key: 'user.manage', effect: 'deny' }], reason: 'explicit deny' })).status).toBe(200);
    const eff = await sa.get(`/rbac/users/${amId}/effective`);
    expect(eff.status).toBe(200);
    const row = (k: string) => eff.body.find((x: { key: string }) => x.key === k);
    expect(row('user.manage')).toMatchObject({ allowed: false });
    expect(row('flag.manage')).toMatchObject({ allowed: false, source: 'role' });
    const catalog = await sa.get('/rbac/permissions');
    expectConforms('GET', '/rbac/permissions', 200, catalog.body);
    expect(catalog.body.find((p: { key: string }) => p.key === 'settings.manage').neverFor).toEqual(['area_manager']);
  });

  it('a branch manager given user.manage still cannot create or reset an area manager', async () => {
    const sa = await web(SA);
    expect((await sa.put(`/rbac/overrides/user/${s.bm.id}`, { changes: [{ key: 'user.manage', effect: 'allow' }], reason: 'let BM manage staff' })).status).toBe(200);
    invalidatePermissions();
    const bm = await web(BM);
    const create = await bm.post('/users', { name: { en: 'Fake AM' }, phone: '01799999998', role: 'area_manager', branchIds: [s.branchA], employeeCode: 'AM998' });
    expect(create.status).toBe(403);
    expect((await bm.post(`/users/${amId}/reset-password`)).status).toBe(403);
    expect((await sa.put(`/rbac/overrides/user/${s.bm.id}`, { changes: [{ key: 'user.manage', effect: 'inherit' }], reason: 'undo the test grant' })).status).toBe(200);
    invalidatePermissions();
  });
});

describe('what an area manager does', () => {
  it('holds exactly the AM column of the catalog (GET /auth/me)', async () => {
    const me = await (await web(AM)).get('/auth/me');
    expect(me.status).toBe(200);
    expect(new Set(me.body.permissions)).toEqual(amDefaults);
    // The second most powerful role: everything the super admin has by default except these.
    expect([...amDefaults]).toEqual(expect.arrayContaining(['customer.view', 'collection.resolve', 'cash.deposit.verify', 'tag.approve', 'device.manage', 'audit.view', 'user.view', 'request.manage', 'report.view']));
    for (const k of ['user.manage', 'rbac.manage', 'flag.manage', 'settings.manage', 'request.important.manage']) expect(amDefaults.has(k)).toBe(false);
  });

  it('every guarded route: 403 exactly when the area manager lacks the key', async () => {
    const am = await web(AM);
    const routes = (await collectRoutes()).filter((r) => typeof r.access === 'object');
    const holds = (r: (typeof routes)[number]) => {
      const a = r.access as { permission: string } | { anyOf: string[] };
      return 'permission' in a ? amDefaults.has(a.permission) : a.anyOf.some((k) => amDefaults.has(k));
    };
    const fake = (p: string) => p.replace(/\{[^}]+\}/g, '000000000000000000000000');
    let denied = 0;
    let allowed = 0;
    for (const r of routes) {
      const url = fake(r.path);
      if (!holds(r)) {
        // The guard answers before the handler, so a fake id and an empty body never reach the service.
        const res = await am[r.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'](url);
        expect(res.status, `${r.method} ${r.path}`).toBe(403);
        expect(res.body.code, `${r.method} ${r.path}`).toBe('FORBIDDEN');
        denied++;
      } else if (r.method === 'GET' && !r.path.includes('{')) {
        const res = await am.get(url);
        expect(res.body?.code === 'FORBIDDEN', `${r.method} ${r.path} → ${res.status}`).toBe(false);
        allowed++;
      }
    }
    expect(denied).toBeGreaterThan(5);
    expect(allowed).toBeGreaterThan(30);
  });

  it('sees every branch, including one that is not in branchIds', async () => {
    const am = await web(AM);
    const bm = await web(BM);
    const custB = (await getByErpId('200301'))!.id; // a customer of branch B
    expect((await am.get(`/customers/${custB}`)).status).toBe(200);
    expect((await bm.get(`/customers/${custB}`)).status).toBe(404);
    const list = await am.get(`/customers?branchId=${s.branchB}&limit=5`);
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThan(0);
    const users = await am.get(`/users?branchId=${s.branchB}`);
    expect(users.body.items.map((u: { id: string }) => u.id)).toContain(s.fsB.id);
    expect((await am.get(`/users/${s.fsB.id}`)).status).toBe(200);
    expect((await bm.get(`/users/${s.fsB.id}`)).status).toBe(404);
    const branches = await am.get('/branches');
    expect(branches.body.map((b: { id: string }) => b.id)).toEqual(expect.arrayContaining([s.branchA, s.branchB]));
    const dash = await am.get(`/dashboard/overview?branchId=${s.branchB}`);
    expect(dash.status).toBe(200);
  });

  it('1.51.0 (ADR-069): web is never bound; in the app the first phone binds and a second phone waits for approval', async () => {
    expect((await login(t.app, AM, { client: 'web' })).accessToken).toBeTruthy();
    expect((await login(t.app, AM, { client: 'web' })).accessToken).toBeTruthy();
    expect((await login(t.app, AM, { client: 'app', deviceId: 'am-phone-1' })).accessToken).toBeTruthy();
    const second = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-device-id': 'am-phone-2' }, payload: { phone: AM, password: PASSWORD, client: 'app' } });
    expect(second.statusCode).toBe(403);
    expect(second.json()).toMatchObject({ code: 'DEVICE_NOT_APPROVED', details: { deviceId: 'am-phone-2', status: 'pending_approval' } });
    const devices = await (await as(t, SA)).get(`/devices?userId=${amId}`);
    expect(devices.status).toBe(200);
    const mine = (devices.body.items ?? devices.body).filter((d: { userId: string }) => d.userId === amId);
    expect(mine.map((d: { deviceId: string; status: string }) => [d.deviceId, d.status]).sort()).toEqual([
      ['am-phone-1', 'active'],
      ['am-phone-2', 'pending_approval'],
    ]);
  });
});
