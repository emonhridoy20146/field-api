import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, client, createTestApp, login, PASSWORD, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { mongoose } from '../../src/core/db/index.js';

/**
 * FR-LOC-013 (1.49.0, ADR-067): the staff app's native location service keeps uploading with a tracking token after
 * the app is closed and the 15-minute access token has expired. The token works on POST /location/points only.
 */
let t: TestApp;
let s: Seeded;
const START = '2026-11-15T04:00:00Z'; // 10:00 Dhaka
const geo = { lat: 22.7105, lng: 90.3702, accuracyM: 8 };
const att = (type: string, at: string) => ({ clientId: randomUUID(), type, at, geo });
const pt = (at: Date | string, lat = 22.7105) => ({ t: typeof at === 'string' ? at : at.toISOString(), lat, lng: 90.3702, acc: 10 });
const minuteAgo = () => new Date(t.clock.now().getTime() - 60_000);

const DEV1 = 'trk-dev-fs1';
const DEV2 = 'trk-dev-fs2';
const DEVB = 'trk-dev-fsB';

/** A request carrying `Authorization: Tracking <token>` (and nothing else), like the native service. */
const tracking = (token: string) => client(t.app, undefined, { authorization: `Tracking ${token}`, 'x-client': 'staff-app/1.0.0 (android 10; Redmi 9A)' });

async function appSession(phone: string, deviceId: string) {
  const l = await login(t.app, phone, { deviceId });
  return { c: client(t.app, l.accessToken, { 'x-device-id': deviceId }), accessToken: l.accessToken };
}

async function issue(c: ReturnType<typeof client>): Promise<string> {
  const r = await c.post('/location/tracking-token');
  expect(r.status).toBe(200);
  return r.body.token as string;
}

const audits = (action: string, entityId: string) => mongoose.connection.db!.collection('audit_logs').find({ action, entityId }).toArray();

beforeAll(async () => {
  t = await createTestApp({ now: START });
  s = await seedBasics(t);
  // Everyone works from 09:00 Dhaka.
  for (const [phone, dev] of [
    [s.fs1.phone, DEV1],
    [s.fs2.phone, DEV2],
    [s.fsB.phone, DEVB],
  ] as const) {
    const { c } = await appSession(phone, dev);
    expect((await c.post('/attendance/events', att('work_in', '2026-11-15T03:00:00Z'))).status).toBe(201);
  }
});
afterAll(async () => t.close());

describe('POST /location/tracking-token', () => {
  it('issues an opaque token bound to the device, stores only its hash, and audits it', async () => {
    t.clock.set(START);
    const { c } = await appSession(s.fs1.phone, DEV1);
    const r = await c.post('/location/tracking-token');
    expect(r.status).toBe(200);
    expectConforms('POST', '/location/tracking-token', 200, r.body);
    expect(r.body.token).toMatch(/^trk_[A-Za-z0-9_-]{43}$/);
    expect(r.body.expiresAt).toBe('2026-11-16T04:00:00.000Z'); // location.trackingTokenTtlHours default 24
    const rows = await mongoose.connection.db!.collection('tracking_tokens').find({ userId: s.fs1.id }).toArray();
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(r.body.token);
    expect(rows.at(-1)).toMatchObject({ deviceId: DEV1, revokedAt: null });
    expect((await audits('auth.tracking_token_issued', s.fs1.id)).length).toBeGreaterThan(0);
  });

  it('401 without a token, 403 for users who do not post points, 403 APP_ONLY for a web session', async () => {
    const anon = await client(t.app).post('/location/tracking-token');
    expect(anon.status).toBe(401);
    expectConforms('POST', '/location/tracking-token', 401, anon.body);

    const viewer = await as(t, s.vw.phone);
    const v = await viewer.post('/location/tracking-token');
    expect(v.status).toBe(403);
    expectConforms('POST', '/location/tracking-token', 403, v.body);
    expect(v.body.details).toMatchObject({ permission: 'attendance.record' });

    const web = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { phone: s.fs2.phone, password: PASSWORD, client: 'web' } });
    expect(web.statusCode).toBe(200);
    const w = await client(t.app, web.json().accessToken).post('/location/tracking-token');
    expect(w.status).toBe(403);
    expect(w.body.details).toMatchObject({ reason: 'APP_ONLY' });
  });
});

describe('POST /location/points with Authorization: Tracking', () => {
  it('keeps accepting points 16 minutes later, when the access token is already refused', async () => {
    t.clock.set(START);
    const { c, accessToken } = await appSession(s.fs1.phone, DEV1);
    const token = await issue(c);
    t.clock.advance(16 * 60_000); // ACCESS_TOKEN_TTL_SEC 900 has passed; nobody refreshed (app closed)

    const old = await client(t.app, accessToken).post('/location/points', { deviceId: DEV1, points: [pt(minuteAgo())] });
    expect(old.status).toBe(401);

    const r = await tracking(token).post('/location/points', { deviceId: DEV1, points: [pt(minuteAgo())] });
    expect(r.status).toBe(200);
    expectConforms('POST', '/location/points', 200, r.body);
    expect(r.body).toMatchObject({ accepted: 1, rejected: [] });

    // The live map moved.
    const bm = await as(t, s.bm.phone);
    const latest = await bm.get('/location/latest');
    expect(latest.body.find((m: { userId: string }) => m.userId === s.fs1.id)).toMatchObject({ source: 'track', recordedAt: minuteAgo().toISOString() });
  });

  it('still rejects off-duty points (before work-in) and points of another device', async () => {
    t.clock.set('2026-11-15T05:00:00Z');
    const { c } = await appSession(s.fs1.phone, DEV1);
    const trk = tracking(await issue(c));
    const r = await trk.post('/location/points', { deviceId: DEV1, points: [pt('2026-11-15T02:30:00Z'), pt(minuteAgo())] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ accepted: 1, rejected: [{ index: 0, reason: 'OFF_DUTY' }] });

    const other = await trk.post('/location/points', { deviceId: 'someone-else', points: [pt(minuteAgo())] });
    expect(other.status).toBe(400);
  });

  it('is refused on every other route (401 TRACKING_TOKEN_NOT_ALLOWED)', async () => {
    t.clock.set(START);
    const { c } = await appSession(s.fs1.phone, DEV1);
    const trk = tracking(await issue(c));
    const calls = [
      trk.post('/location/heartbeat', { battery: 0.5 }),
      trk.post('/location/tracking-token'),
      trk.get('/auth/me'),
      trk.get('/customers'),
      trk.get('/sync/pull'),
      trk.post('/attendance/events', att('break_start', '2026-11-15T03:59:00Z')),
      trk.post('/auth/logout'),
    ];
    for (const r of await Promise.all(calls)) {
      expect(r.status).toBe(401);
      expect(r.body).toMatchObject({ code: 'UNAUTHENTICATED', details: { reason: 'TRACKING_TOKEN_NOT_ALLOWED' } });
    }
    // Still good on the one route it is for.
    expect((await trk.post('/location/points', { deviceId: DEV1, points: [pt(minuteAgo())] })).status).toBe(200);
  });

  it('is rate limited per user like the access-token route, not per shared IP', async () => {
    t.clock.set(START);
    const a = tracking(await issue((await appSession(s.fs1.phone, DEV1)).c));
    const b = tracking(await issue((await appSession(s.fs2.phone, DEV2)).c));
    const left = async (c: ReturnType<typeof tracking>) => Number((await c.post('/location/points', { deviceId: c === a ? DEV1 : DEV2, points: [] })).headers['x-ratelimit-remaining']);
    const a1 = await left(a);
    const a2 = await left(a);
    const b1 = await left(b);
    expect(a2).toBe(a1 - 1);
    expect(b1).toBeGreaterThan(a2); // fs2 has its own bucket although both come from the same IP
  });

  it('401 for an unknown, malformed or Bearer-sent tracking token', async () => {
    t.clock.set(START);
    const body = { deviceId: DEV1, points: [pt(minuteAgo())] };
    const unknown = await tracking(`trk_${'A'.repeat(43)}`).post('/location/points', body);
    expect(unknown.status).toBe(401);
    expectConforms('POST', '/location/points', 401, unknown.body);
    expect(unknown.body.details).toMatchObject({ reason: 'TRACKING_TOKEN_INVALID' });
    expect((await tracking('nope').post('/location/points', body)).status).toBe(401);
    const { c } = await appSession(s.fs1.phone, DEV1);
    const token = await issue(c);
    expect((await client(t.app, token).post('/location/points', body)).status).toBe(401); // not a JWT
  });

  it('a rotated token is refused; the new one works', async () => {
    t.clock.set(START);
    const { c } = await appSession(s.fs1.phone, DEV1);
    const first = await issue(c);
    const second = await issue(c);
    const body = { deviceId: DEV1, points: [pt(minuteAgo())] };
    const r = await tracking(first).post('/location/points', body);
    expect(r.status).toBe(401);
    expect(r.body.details).toMatchObject({ reason: 'TRACKING_TOKEN_INVALID' });
    expect((await tracking(second).post('/location/points', body)).status).toBe(200);
  });

  it('expires after location.trackingTokenTtlHours (401 TRACKING_TOKEN_EXPIRED)', async () => {
    t.clock.set(START);
    const { c } = await appSession(s.fs1.phone, DEV1);
    const token = await issue(c);
    t.clock.set('2026-11-16T04:00:01Z');
    const r = await tracking(token).post('/location/points', { deviceId: DEV1, points: [] });
    expect(r.status).toBe(401);
    expect(r.body.details).toMatchObject({ reason: 'TRACKING_TOKEN_EXPIRED' });
  });

  it('403 when the user lost attendance.record (a tracking token is not a permission bypass)', async () => {
    t.clock.set(START);
    const { c } = await appSession(s.fs1.phone, DEV1);
    const trk = tracking(await issue(c));
    const sa = await as(t, s.sa.phone);
    const deny = await sa.put(`/rbac/overrides/user/${s.fs1.id}`, { changes: [{ key: 'attendance.record', effect: 'deny' }], reason: 'tracking token test' });
    expect(deny.status).toBe(200);
    try {
      const r = await trk.post('/location/points', { deviceId: DEV1, points: [pt(minuteAgo())] });
      expect(r.status).toBe(403);
      expectConforms('POST', '/location/points', 403, r.body);
      expect(r.body.details).toMatchObject({ permission: 'attendance.record' });
    } finally {
      await sa.put(`/rbac/overrides/user/${s.fs1.id}`, { changes: [{ key: 'attendance.record', effect: 'inherit' }], reason: 'tracking token test' });
    }
  });
});

describe('revocation (logout, password reset, device unbind, deactivate)', () => {
  const body = (deviceId: string) => ({ deviceId, points: [pt(minuteAgo())] });

  it('logout revokes the tracking token', async () => {
    t.clock.set(START);
    const { c } = await appSession(s.fs1.phone, DEV1);
    const token = await issue(c);
    expect((await tracking(token).post('/location/points', body(DEV1))).status).toBe(200);
    expect((await c.post('/auth/logout')).status).toBe(204);
    const r = await tracking(token).post('/location/points', body(DEV1));
    expect(r.status).toBe(401);
    expect(r.body.details).toMatchObject({ reason: 'TRACKING_TOKEN_INVALID' });
    const revoked = await audits('auth.tracking_token_revoked', s.fs1.id);
    expect(revoked.some((a) => (a.after as { reason?: string }).reason === 'logout')).toBe(true);
  });

  it('an admin password reset revokes it', async () => {
    t.clock.set(START);
    const { c } = await appSession(s.fs1.phone, DEV1);
    const token = await issue(c);
    const sa = await as(t, s.sa.phone);
    expect((await sa.post(`/users/${s.fs1.id}/reset-password`)).status).toBe(200);
    expect((await tracking(token).post('/location/points', body(DEV1))).status).toBe(401);
  });

  it('unbinding the device revokes it', async () => {
    t.clock.set(START);
    const { c } = await appSession(s.fs2.phone, DEV2);
    const token = await issue(c);
    expect((await tracking(token).post('/location/points', body(DEV2))).status).toBe(200);
    const bm = await as(t, s.bm.phone);
    const dev = (await bm.get(`/devices?userId=${s.fs2.id}`)).body.find((d: { deviceId: string }) => d.deviceId === DEV2);
    expect((await bm.post(`/devices/${dev.id}/unbind`, { reason: 'phone lost' })).status).toBe(200);
    const r = await tracking(token).post('/location/points', body(DEV2));
    expect(r.status).toBe(401);
    const revoked = await audits('auth.tracking_token_revoked', s.fs2.id);
    expect(revoked.some((a) => (a.after as { reason?: string }).reason === 'device_unbound')).toBe(true);
  });

  it('deactivating the user revokes it', async () => {
    t.clock.set(START);
    const { c } = await appSession(s.fsB.phone, DEVB);
    const token = await issue(c);
    expect((await tracking(token).post('/location/points', body(DEVB))).status).toBe(200);
    const sa = await as(t, s.sa.phone);
    expect((await sa.post(`/users/${s.fsB.id}/deactivate`, { reason: 'left the company' })).status).toBe(200);
    const r = await tracking(token).post('/location/points', body(DEVB));
    expect(r.status).toBe(401);
    expect(r.body.details).toMatchObject({ reason: 'TRACKING_TOKEN_INVALID' });
  });
});
