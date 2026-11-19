import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, client, createTestApp, login, PASSWORD, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { contractVersion, expectConforms } from '../helpers/openapi.js';
import { verifyChain } from '../../src/modules/audit/index.js';
import { setFlagSystem } from '../../src/modules/flags/index.js';

let t: TestApp;
let s: Seeded;

beforeAll(async () => {
  t = await createTestApp();
  s = await seedBasics(t);
});
afterAll(async () => t.close());

describe('auth (FR-AUTH-001..005)', () => {
  it('logs in by phone, returns permissions + flags, conforms to contract', async () => {
    const res = await client(t.app).post('/auth/login', { phone: '01700000003', password: PASSWORD, client: 'app' }, { 'x-device-id': 'dev-fs1' });
    expect(res.status).toBe(200);
    expectConforms('POST', '/auth/login', 200, res.body);
    expect(res.body.user.role).toBe('field_staff');
    expect(res.body.permissions).toContain('branch.view');
    expect(res.body.permissions).not.toContain('user.manage');
    expect(res.body.refreshToken).toMatch(/^rt_/);
  });

  it('rejects wrong password with generic 401 and audits it', async () => {
    const res = await client(t.app).post('/auth/login', { phone: '01700000002', password: 'nope-nope', client: 'web' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
    expectConforms('POST', '/auth/login', 401, res.body);
  });

  it('locks after 5 failures in 15 minutes (423)', async () => {
    const c = client(t.app);
    for (let i = 0; i < 5; i++) await c.post('/auth/login', { phone: '01700000006', password: 'wrong-pass', client: 'web' }, { 'x-forwarded-for': '9.9.9.9' });
    const res = await c.post('/auth/login', { phone: '01700000006', password: PASSWORD, client: 'web' });
    expect(res.status).toBe(423);
    expect(res.body.details.until).toBeTruthy();
    t.clock.advance(16 * 60_000);
    expect((await c.post('/auth/login', { phone: '01700000006', password: PASSWORD, client: 'web' })).status).toBe(200);
  });

  it('web login sets an HttpOnly refresh cookie and omits the token from the body', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { phone: '01700000002', password: PASSWORD, client: 'web' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().refreshToken).toBeUndefined();
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/fos_rt=rt_/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    const rt = /fos_rt=([^;]+)/.exec(cookie)![1]!;
    const refreshed = await t.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', cookies: { fos_rt: rt }, payload: {} });
    expect(refreshed.statusCode).toBe(200);
  });

  it('rotates refresh tokens and revokes the family on reuse (FR-AUTH-002)', async () => {
    const l = await login(t.app, '01700000004');
    const c = client(t.app);
    const r1 = await c.post('/auth/refresh', { refreshToken: l.refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(l.refreshToken);
    const reuse = await c.post('/auth/refresh', { refreshToken: l.refreshToken });
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe('REFRESH_REUSED');
    // the newer token died with the family
    expect((await c.post('/auth/refresh', { refreshToken: r1.body.refreshToken })).status).toBe(401);
    // and the access token's session is gone
    expect((await client(t.app, r1.body.accessToken).get('/auth/me')).status).toBe(401);
  });

  it('expired access token → 401 TOKEN_EXPIRED', async () => {
    const l = await login(t.app, '01700000004');
    t.clock.advance(16 * 60_000);
    const res = await client(t.app, l.accessToken).get('/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_EXPIRED');
  });

  it('enforces password policy and revokes other sessions on change (FR-AUTH-003)', async () => {
    const a = await login(t.app, '01700000005');
    const b = await login(t.app, '01700000005', { client: 'web' });
    const c = client(t.app, a.accessToken);
    const weak = await c.post('/auth/password/change', { currentPassword: PASSWORD, newPassword: 'password' });
    expect(weak.status).toBe(422);
    expect(weak.body.details.rule).toBe('PASSWORD_TOO_COMMON');
    const asPhone = await c.post('/auth/password/change', { currentPassword: PASSWORD, newPassword: '01700000005' });
    expect(asPhone.body.details.rule).toBe('PASSWORD_EQUALS_PHONE');
    const ok = await c.post('/auth/password/change', { currentPassword: PASSWORD, newPassword: 'N3w-Strong-Pass' });
    expect(ok.status).toBe(204);
    expect((await client(t.app, b.accessToken).get('/auth/me')).status).toBe(401);
    expect((await c.get('/auth/me')).status).toBe(200);
    await c.post('/auth/password/change', { currentPassword: 'N3w-Strong-Pass', newPassword: PASSWORD });
  });

  it('lists and revokes own sessions', async () => {
    const c = await as(t, '01700000004');
    const list = await c.get('/auth/sessions');
    expect(list.status).toBe(200);
    expectConforms('GET', '/auth/sessions', 200, list.body);
    const other = list.body.find((x: { current: boolean }) => !x.current);
    if (other) expect((await c.delete(`/auth/sessions/${other.id}`)).status).toBe(204);
  });
});

describe('users (FR-USER-*, FR-AUTH-004, FR-RBAC-007)', () => {
  it('SA creates a field staff with a temporary password that must be changed', async () => {
    const sa = await as(t, '01700000001');
    const res = await sa.post('/users', { name: { bn: 'নতুন কর্মী', en: 'New Staff' }, phone: '01800000010', role: 'field_staff', branchIds: [s.branchA], employeeCode: 'FS020' });
    expect(res.status).toBe(201);
    expectConforms('POST', '/users', 201, res.body);
    const l = await login(t.app, '01800000010', { password: res.body.temporaryPassword });
    expect(l.user.mustChangePassword).toBe(true);
    const c = client(t.app, l.accessToken);
    expect((await c.get('/branches')).body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await c.get('/auth/me')).status).toBe(200);
  });

  it('rejects duplicate phone and invalid phone', async () => {
    const sa = await as(t, '01700000001');
    const dup = await sa.post('/users', { name: { en: 'X' }, phone: '01700000003', role: 'field_staff', branchIds: [s.branchA], employeeCode: 'FS099' });
    expect(dup.status).toBe(422);
    const bad = await sa.post('/users', { name: { en: 'X' }, phone: '12345', role: 'field_staff', branchIds: [s.branchA], employeeCode: 'FS098' });
    expect(bad.status).toBe(400);
  });

  it('BM lacks user.manage by default; viewer can list users in branch only', async () => {
    const bm = await as(t, '01700000002');
    expect((await bm.post('/users', { name: { en: 'X' }, phone: '01800000011', role: 'field_staff', branchIds: [s.branchA], employeeCode: 'FS021' })).status).toBe(403);
    const vw = await as(t, '01700000006');
    const list = await vw.get('/users?limit=100');
    expect(list.status).toBe(200);
    expectConforms('GET', '/users', 200, list.body);
    expect(list.body.items.every((u: { branchIds: string[] }) => u.branchIds.includes(s.branchA))).toBe(true);
    expect((await vw.get(`/users/${s.fsB.id}`)).status).toBe(404);
  });

  it('uses ETag/If-Match for updates', async () => {
    const sa = await as(t, '01700000001');
    const g = await sa.get(`/users/${s.fs2.id}`);
    const stale = await sa.patch(`/users/${s.fs2.id}`, { name: { en: 'Sumon M', bn: 'সুমন' } }, { 'if-match': 'W/"999"' });
    expect(stale.status).toBe(412);
    const ok = await sa.patch(`/users/${s.fs2.id}`, { name: { en: 'Sumon M', bn: 'সুমন' } }, { 'if-match': String(g.headers.etag) });
    expect(ok.status).toBe(200);
    expectConforms('PATCH', `/users/${s.fs2.id}`, 200, ok.body);
  });

  it('guards the last super admin', async () => {
    const sa = await as(t, '01700000001');
    const res = await sa.patch(`/users/${s.sa.id}`, { role: 'branch_manager' });
    expect(res.status).toBe(422);
    expect(res.body.details.rule).toBe('LAST_SUPER_ADMIN');
  });

  it('deactivation blocks login and revokes sessions (FR-USER-002)', async () => {
    const sa = await as(t, '01700000001');
    const created = await sa.post('/users', { name: { en: 'Temp' }, phone: '01800000012', role: 'field_staff', branchIds: [s.branchA], employeeCode: 'FS022' });
    const l = await login(t.app, '01800000012', { password: created.body.temporaryPassword });
    expect((await sa.post(`/users/${created.body.user.id}/deactivate`, { reason: 'left the company' })).status).toBe(200);
    expect((await client(t.app, l.accessToken).get('/auth/me')).status).toBe(401);
    expect((await client(t.app).post('/auth/login', { phone: '01800000012', password: created.body.temporaryPassword, client: 'app' })).status).toBe(401);
  });

  it('admin reset password gives a temp password and revokes sessions', async () => {
    const sa = await as(t, '01700000001');
    const created = await sa.post('/users', { name: { en: 'Temp2' }, phone: '01800000013', role: 'field_staff', branchIds: [s.branchA], employeeCode: 'FS023' });
    const l = await login(t.app, '01800000013', { password: created.body.temporaryPassword });
    const r = await sa.post(`/users/${created.body.user.id}/reset-password`);
    expect(r.status).toBe(200);
    expect(r.body.temporaryPassword).toBeTruthy();
    expect((await client(t.app, l.accessToken).get('/auth/me')).status).toBe(401);
  });
});

describe('rbac (FR-RBAC-002..005)', () => {
  it('catalog lists every key once with module and defaults, including reserved microfinance', async () => {
    const sa = await as(t, '01700000001');
    const res = await sa.get('/rbac/permissions');
    expect(res.status).toBe(200);
    expectConforms('GET', '/rbac/permissions', 200, res.body);
    const keys = res.body.map((p: { key: string }) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(res.body.find((p: { key: string }) => p.key === 'microfinance.view').reserved).toBe(true);
  });

  it('user override removes a permission, explains its source, and is audited with reason', async () => {
    const sa = await as(t, '01700000001');
    const res = await sa.put(`/rbac/overrides/user/${s.fs2.id}`, { changes: [{ key: 'branch.view', effect: 'deny' }], reason: 'test override' });
    expect(res.status).toBe(200);
    const eff = await sa.get(`/rbac/users/${s.fs2.id}/effective`);
    expectConforms('GET', `/rbac/users/${s.fs2.id}/effective`, 200, eff.body);
    expect(eff.body.find((e: { key: string }) => e.key === 'branch.view')).toEqual({ key: 'branch.view', allowed: false, source: 'user' });
    const fs2 = await as(t, '01700000004');
    expect((await fs2.get('/branches')).status).toBe(403);
    const auditRes = await sa.get(`/audit?action=rbac.override.set&entityId=${s.fs2.id}`);
    expect(auditRes.status).toBe(200);
    expectConforms('GET', '/audit', 200, auditRes.body);
    expect(auditRes.body.items[0]).toMatchObject({ reason: 'test override', before: { effect: 'inherit' }, after: { effect: 'deny' } });
    await sa.put(`/rbac/overrides/user/${s.fs2.id}`, { changes: [{ key: 'branch.view', effect: 'inherit' }], reason: 'revert test' });
    expect((await (await as(t, '01700000004')).get('/branches')).status).toBe(200);
  });

  it('branch override applies per role; reserved keys cannot be granted; non-SA cannot manage', async () => {
    const sa = await as(t, '01700000001');
    expect((await sa.put(`/rbac/overrides/branch/${s.branchA}`, { role: 'field_staff', changes: [{ key: 'microfinance.view', effect: 'allow' }], reason: 'should fail' })).status).toBe(422);
    expect((await sa.put(`/rbac/overrides/branch/${s.branchA}`, { role: 'branch_manager', changes: [{ key: 'user.manage', effect: 'allow' }], reason: 'BM can manage staff' })).status).toBe(200);
    const bm = await as(t, '01700000002');
    const created = await bm.post('/users', { name: { en: 'By BM' }, phone: '01800000014', role: 'field_staff', branchIds: [s.branchA], employeeCode: 'FS024' });
    expect(created.status).toBe(201);
    // BM can never create SA/BM or users in other branches
    expect((await bm.post('/users', { name: { en: 'X' }, phone: '01800000015', role: 'branch_manager', branchIds: [s.branchA], employeeCode: 'BM009' })).status).toBe(403);
    expect((await bm.post('/users', { name: { en: 'X' }, phone: '01800000016', role: 'field_staff', branchIds: [s.branchB], employeeCode: 'FS025' })).status).toBe(403);
    expect((await bm.put(`/rbac/overrides/user/${s.fs1.id}`, { changes: [{ key: 'tag.set', effect: 'deny' }], reason: 'nope nope' })).status).toBe(403);
  });
});

describe('flags (FR-FLAG-001/002) and microfinance lock (FR-MF-001)', () => {
  it('disabled module returns 403 FEATURE_DISABLED; per-branch override works', async () => {
    await setFlagSystem('module.devices', false);
    const sa = await as(t, '01700000001');
    const off = await sa.get('/devices');
    expect(off.status).toBe(403);
    expect(off.body.code).toBe('FEATURE_DISABLED');
    expect((await sa.put('/feature-flags/module.devices', { branchOverrides: [{ branchId: s.branchB, enabled: true }], reason: 'pilot branch B' })).status).toBe(200);
    const bm = await as(t, '01700000002'); // branch A only
    expect((await bm.get('/devices')).body.code).toBe('FEATURE_DISABLED');
    expect((await sa.get('/devices')).status).toBe(200);
    const list = await sa.get('/feature-flags');
    expectConforms('GET', '/feature-flags', 200, list.body);
    expect(list.body.find((f: { key: string }) => f.key === 'module.microfinance').lockedReason).toBeTruthy();
  });

  it('microfinance flag cannot be enabled without legal approval', async () => {
    const sa = await as(t, '01700000001');
    const res = await sa.put('/feature-flags/module.microfinance', { defaultEnabled: true, reason: 'try to enable' });
    expect(res.status).toBe(422);
    expect(res.body.details.rule).toBe('FLAG_LOCKED');
  });
});

describe('settings, meta and version gate (FR-SET-001, FR-AUTH-009)', () => {
  it('validates typed settings, audits, and exposes app subset to staff', async () => {
    const sa = await as(t, '01700000001');
    const fs = await as(t, '01700000003');
    expect((await sa.patch('/settings', { changes: { 'app.minVersion': 5 }, reason: 'bad type' })).status).toBe(400);
    expect((await sa.patch('/settings', { changes: { 'app.minVersion': '1.2.0' }, reason: 'force upgrade' })).status).toBe(200);
    const st = await fs.get('/settings');
    expect(st.status).toBe(200);
    expect(st.body['app.minVersion']).toBeUndefined();
    expect(st.body['map.tileProvider']).toBeTruthy();
    const old = await client(t.app, undefined, { 'x-client': 'staff-app/1.1.9 (android 9; X)' }).post('/auth/login', { phone: '01700000003', password: PASSWORD, client: 'app' });
    expect(old.status).toBe(426);
    expect(old.body.details.minVersion).toBe('1.2.0');
    const meta = await client(t.app, undefined, { 'x-client': 'staff-app/1.1.9 (android 9; X)' }).get('/meta/app-config');
    expect(meta.status).toBe(200);
    expectConforms('GET', '/meta/app-config', 200, meta.body);
    await sa.patch('/settings', { changes: { 'app.minVersion': '1.0.0' }, reason: 'reset for tests' });
  });

  it('health is public and conforms', async () => {
    const res = await client(t.app).get('/system/health');
    expect(res.status).toBe(200);
    expectConforms('GET', '/system/health', 200, res.body);
    // the deployed contract is visible; keep src/core/http/contract.ts in step with docs/openapi.yaml
    expect(res.body.contract).toBe(contractVersion());
  });

  it('shifts and holidays', async () => {
    const sa = client(t.app, (await login(t.app, '01700000001', { client: 'web' })).accessToken);
    expect((await sa.post('/shifts', { name: 'Late', start: '18:00', end: '09:00' })).status).toBe(422);
    const sh = await sa.post('/shifts', { name: 'Day', start: '09:00', end: '18:00' });
    expect(sh.status).toBe(201);
    expect((await sa.post('/calendar/holidays', { date: '2026-12-16', name: { bn: 'বিজয় দিবস', en: 'Victory Day' } })).status).toBe(201);
    const h = await sa.get('/calendar/holidays?year=2026');
    expectConforms('GET', '/calendar/holidays', 200, h.body);
    expect(h.body).toHaveLength(1);
  });
});

describe('errors and audit chain', () => {
  it('401 without token, problem+json shape, unknown route 404', async () => {
    const res = await client(t.app).get('/users');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
    expect(res.body).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect((await client(t.app).get('/nope')).status).toBe(404);
  });

  it('audit hash chain verifies', async () => {
    const r = await verifyChain();
    expect(r.ok).toBe(true);
    expect(r.checked).toBeGreaterThan(10);
  });
});
