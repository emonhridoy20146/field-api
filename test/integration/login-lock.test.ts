import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, createTestApp, login, PASSWORD, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { clearSettingsCache, setSystem } from '../../src/modules/settings/index.js';

/**
 * Owner report 2026-11-24 (ADR-064): staff behind one office / carrier NAT share an IP, so one person's wrong
 * passwords locked everyone. The account lock stays at 5; the IP lock is higher and skips known devices/browsers.
 */
let t: TestApp;
let s: Seeded;

beforeAll(async () => {
  t = await createTestApp({ env: { TRUST_PROXY: 'true' } });
  s = await seedBasics(t);
});
afterAll(async () => t.close());

const APP = 'staff-app/1.0.0 (android 10; Redmi 9A)';
const loginFrom = (ip: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-forwarded-for': ip, 'x-client': APP, 'accept-language': 'en', ...headers }, payload: body });

describe('office NAT: one user mistyping does not lock the others (FR-AUTH-005)', () => {
  const OFFICE = '203.0.113.7';

  it('5 wrong passwords lock that account only; colleagues on the same IP still log in', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await loginFrom(OFFICE, { phone: s.fs1.phone, password: 'wrong-pass', client: 'app' }, { 'x-device-id': 'dev-fs1-office' });
      expect(r.statusCode).toBe(401);
    }
    const locked = await loginFrom(OFFICE, { phone: s.fs1.phone, password: PASSWORD, client: 'app' }, { 'x-device-id': 'dev-fs1-office' });
    expect(locked.statusCode).toBe(423);
    const body = locked.json();
    expectConforms('POST', '/auth/login', 423, body);
    expect(body.code).toBe('ACCOUNT_LOCKED');
    expect(body.details.scope).toBe('account');
    expect(new Date(body.details.until).getTime()).toBe(t.clock.now().getTime() + 15 * 60_000);
    expect(body.details.retryAfterSec).toBe(900);
    expect(locked.headers['retry-after']).toBe('900');

    // Another field staff and a manager (web) behind the same NAT are not affected.
    const other = await loginFrom(OFFICE, { phone: s.fs2.phone, password: PASSWORD, client: 'app' }, { 'x-device-id': 'dev-fs2-office' });
    expect(other.statusCode).toBe(200);
    const manager = await loginFrom(OFFICE, { phone: s.bm.phone, password: PASSWORD, client: 'web' });
    expect(manager.statusCode).toBe(200);

    t.clock.advance(16 * 60_000);
    expect((await loginFrom(OFFICE, { phone: s.fs1.phone, password: PASSWORD, client: 'app' }, { 'x-device-id': 'dev-fs1-office' })).statusCode).toBe(200);
  });
});

describe('IP lock: still stops guessing across accounts, but not known devices (ADR-064)', () => {
  const NAT = '198.51.100.9';

  beforeAll(async () => {
    t.clock.advance(16 * 60_000);
    await setSystem('auth.ipLockFailures', 6); // default 50; lower here to keep the test fast
    clearSettingsCache();
  });
  afterAll(async () => {
    await setSystem('auth.ipLockFailures', 50);
    clearSettingsCache();
  });

  it('locks the IP after the threshold; unknown device gets 423 scope ip even with the right password', async () => {
    // fsB has a session from device dev-fsB-known (from home, another IP) before the attack starts.
    await login(t.app, s.fsB.phone, { deviceId: 'dev-fsB-known' });
    // Guessing across several accounts: no single account reaches 5.
    const victims = ['01799999901', '01799999902', '01799999903', s.vw.phone, s.vw.phone, s.vw.phone];
    for (const phone of victims) expect((await loginFrom(NAT, { phone, password: 'guess-1234', client: 'web' })).statusCode).toBe(401);

    const unknownDevice = await loginFrom(NAT, { phone: s.fs2.phone, password: PASSWORD, client: 'app' }, { 'x-device-id': 'dev-never-seen' });
    expect(unknownDevice.statusCode).toBe(423);
    expectConforms('POST', '/auth/login', 423, unknownDevice.json());
    expect(unknownDevice.json().details.scope).toBe('ip');
    // Same answer for a wrong password: a locked IP learns nothing.
    const wrong = await loginFrom(NAT, { phone: s.fs2.phone, password: 'nope-nope', client: 'app' }, { 'x-device-id': 'dev-never-seen' });
    expect(wrong.statusCode).toBe(423);
    expect(wrong.json().details.scope).toBe('ip');
    // A web login without the browser's refresh cookie is also refused.
    expect((await loginFrom(NAT, { phone: s.sa.phone, password: PASSWORD, client: 'web' })).statusCode).toBe(423);
  });

  it('a device that already had a session of the user logs in through the IP lock', async () => {
    const ok = await loginFrom(NAT, { phone: s.fsB.phone, password: PASSWORD, client: 'app' }, { 'x-device-id': 'dev-fsB-known' });
    expect(ok.statusCode).toBe(200);
    expectConforms('POST', '/auth/login', 200, ok.json());
    // The known device is not someone else's: another user on that device id is still stopped.
    expect((await loginFrom(NAT, { phone: s.fs1.phone, password: PASSWORD, client: 'app' }, { 'x-device-id': 'dev-fsB-known' })).statusCode).toBe(423);
    // A wrong password from the known device counts towards the account lock as usual.
    const bad = await loginFrom(NAT, { phone: s.fsB.phone, password: 'nope-nope', client: 'app' }, { 'x-device-id': 'dev-fsB-known' });
    expect(bad.statusCode).toBe(401);
  });

  it('a browser with the user\'s refresh cookie logs in through the IP lock', async () => {
    const first = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-forwarded-for': '192.0.2.50' }, payload: { phone: s.sa.phone, password: PASSWORD, client: 'web' } });
    const rt = /fos_rt=([^;]+)/.exec(String(first.headers['set-cookie']))![1]!;
    const ok = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-forwarded-for': NAT }, cookies: { fos_rt: rt }, payload: { phone: s.sa.phone, password: PASSWORD, client: 'web' } });
    expect(ok.statusCode).toBe(200);
    // The cookie of one user does not open the IP lock for another.
    const other = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-forwarded-for': NAT }, cookies: { fos_rt: rt }, payload: { phone: s.bm.phone, password: PASSWORD, client: 'web' } });
    expect(other.statusCode).toBe(423);
  });

  it('the IP lock is per client IP (X-Forwarded-For) and ends after 15 minutes', async () => {
    expect((await loginFrom('198.51.100.10', { phone: s.fs2.phone, password: PASSWORD, client: 'app' }, { 'x-device-id': 'dev-fs2-office' })).statusCode).toBe(200);
    t.clock.advance(16 * 60_000);
    expect((await loginFrom(NAT, { phone: s.vw.phone, password: PASSWORD, client: 'web' })).statusCode).toBe(200);
  });

  it('the account lock still applies on a known device', async () => {
    t.clock.advance(16 * 60_000);
    for (let i = 0; i < 5; i++) await loginFrom('192.0.2.60', { phone: s.fsB.phone, password: 'wrong-pass', client: 'app' }, { 'x-device-id': 'dev-fsB-known' });
    const r = await loginFrom('192.0.2.60', { phone: s.fsB.phone, password: PASSWORD, client: 'app' }, { 'x-device-id': 'dev-fsB-known' });
    expect(r.statusCode).toBe(423);
    expect(r.json().details.scope).toBe('account');
    t.clock.advance(16 * 60_000);
  });

  it('validation still answers 400 before any lock logic', async () => {
    expect((await client(t.app).post('/auth/login', { phone: s.fs1.phone, client: 'app' })).status).toBe(400);
  });
});
