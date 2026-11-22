import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { loadConfig } from '../../src/core/config/index.js';
import { storageDriver } from '../../src/core/storage/index.js';

// ADR-039: on a host without S3 (the Vercel test deployment) files are kept in MongoDB behind signed
// URLs. Before, the API handed out memory:// URLs: the phone could not upload the work-in photo, the
// held work-in never reached the server, and every location point after it was refused as off duty.
let t: TestApp;
let s: Seeded;
const BASE = 'https://fos-api.example.test';

beforeAll(async () => {
  t = await createTestApp({ env: { STORAGE_DRIVER: 'db', PUBLIC_BASE_URL: BASE } });
  s = await seedBasics(t, { flagsOn: true });
});
afterAll(async () => t.close());

const jpeg = (n: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2_000 + n, n % 251), Buffer.from([0xff, 0xd9])]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
// Links use the origin the caller reached the API on (inject requests arrive on localhost), not PUBLIC_BASE_URL.
const pathOf = (url: string) => {
  const u = new URL(url);
  expect(u.pathname).toBe('/api/v1/storage/o');
  expect(u.searchParams.get('t')).toBeTruthy();
  return `${u.pathname}${u.search}`;
};

async function uploadSelfie(c: Awaited<ReturnType<typeof as>>, body: Buffer) {
  const r = await c.post('/media/upload-url', { kind: 'selfie', contentType: 'image/jpeg', sizeBytes: body.length, sha256: sha(body) });
  expect(r.status).toBe(201);
  const put = await t.app.inject({ method: 'PUT', url: pathOf(r.body.uploadUrl as string), headers: { 'content-type': 'image/jpeg' }, payload: body });
  return { mediaId: r.body.mediaId as string, put };
}

describe('files in the database when there is no S3 (ADR-039)', () => {
  it('picks the driver: explicit setting, S3 when configured, database on Vercel, memory in development', () => {
    expect(storageDriver(loadConfig({ NODE_ENV: 'test', STORAGE_DRIVER: 'db' }))).toBe('db');
    expect(storageDriver(loadConfig({ NODE_ENV: 'staging', VERCEL: '1' }))).toBe('db');
    const keys = { S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 'b' };
    expect(storageDriver(loadConfig({ NODE_ENV: 'staging', VERCEL: '1', S3_ENDPOINT: 'https://r2.example.test', ...keys }))).toBe('s3');
    // An endpoint or a key id alone is not S3 (1.38.0): it used to send phone uploads to a store that was not set up.
    expect(storageDriver(loadConfig({ NODE_ENV: 'staging', VERCEL: '1', S3_ENDPOINT: 'https://r2.example.test' }))).toBe('db');
    expect(storageDriver(loadConfig({ NODE_ENV: 'staging', VERCEL: '1', S3_ACCESS_KEY_ID: 'a' }))).toBe('db');
    expect(storageDriver(loadConfig({ NODE_ENV: 'staging', VERCEL: '1', STORAGE_DRIVER: 's3' }))).toBe('db'); // leftover setting without keys
    expect(storageDriver(loadConfig({ NODE_ENV: 'development' }))).toBe('memory');
    expect(storageDriver(loadConfig({ NODE_ENV: 'development', STORAGE_DRIVER: '' }))).toBe('memory');
  });

  it('uses the Vercel production host when PUBLIC_BASE_URL is not set', () => {
    expect(loadConfig({ NODE_ENV: 'staging', VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'fos.example.test' }).PUBLIC_BASE_URL).toBe('https://fos.example.test');
    expect(loadConfig({ NODE_ENV: 'development' }).PUBLIC_BASE_URL).toBe('http://localhost:4000');
  });

  it('signs links for the host the caller used, so a wrong PUBLIC_BASE_URL cannot break uploads', async () => {
    const fs = await as(t, '01700000003');
    const body = jpeg(9);
    const ask = (h: Record<string, string>) => fs.post('/media/upload-url', { kind: 'selfie', contentType: 'image/jpeg', sizeBytes: body.length, sha256: sha(body) }, h);
    const viaProxy = await ask({ 'x-forwarded-host': 'fos-live.example.test', 'x-forwarded-proto': 'https' });
    expect(viaProxy.status).toBe(201);
    expect((viaProxy.body.uploadUrl as string).startsWith('https://fos-live.example.test/api/v1/storage/o?t=')).toBe(true);
    const odd = await ask({ 'x-forwarded-host': 'bad host/<x>' });
    expect((odd.body.uploadUrl as string).startsWith(`${BASE}/api/v1/storage/o?t=`)).toBe(true); // a malformed host falls back to the setting
    const health = await t.app.inject({ method: 'GET', url: '/api/v1/system/health' });
    expect(health.json().storage).toBe('db');
  });

  it('upload, confirm and read back a photo through signed URLs', async () => {
    const fs = await as(t, '01700000003');
    const body = jpeg(1);
    const { mediaId, put } = await uploadSelfie(fs, body);
    expect(put.statusCode).toBe(200);
    expectConforms('PUT', '/storage/o', 200, put.json());
    expect((await fs.post(`/media/${mediaId}/confirm`)).body.status).toBe('uploaded');
    const url = await fs.get(`/media/${mediaId}/url`);
    const got = await t.app.inject({ method: 'GET', url: pathOf(url.body.url as string) });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.compare(got.rawPayload, body)).toBe(0);
  });

  it('refuses a forged, reused-for-another-method or expired URL, and a body that differs from the signed one', async () => {
    const fs = await as(t, '01700000003');
    const body = jpeg(2);
    const r = await fs.post('/media/upload-url', { kind: 'selfie', contentType: 'image/jpeg', sizeBytes: body.length, sha256: sha(body) });
    const url = pathOf(r.body.uploadUrl as string);
    const send = (u: string, b: Buffer, type = 'image/jpeg') => t.app.inject({ method: 'PUT', url: u, headers: { 'content-type': type }, payload: b });
    const forged = url.replace(/\.[^.]+$/, '.AAAA');
    expect((await send('/api/v1/storage/o', body)).statusCode).toBe(403); // no grant at all
    expect((await send(forged, body)).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url })).statusCode).toBe(403); // a PUT grant cannot read
    const other = jpeg(3);
    expect((await send(url, other)).statusCode).toBe(400); // size or checksum differs
    expect((await send(url, body, 'image/webp')).statusCode).toBe(400);
    expect((await fs.post(`/media/${r.body.mediaId}/confirm`)).status).toBe(409); // nothing stored yet
    t.clock.set(new Date(t.clock.now().getTime() + 6 * 60_000).toISOString());
    expect((await send(url, body)).statusCode).toBe(403); // expired after 5 minutes
  });

  it('a work-in with its photo reaches the server, and location points after it are kept', async () => {
    t.clock.set('2026-11-16T03:10:00Z'); // 09:10 Dhaka
    const fs = await as(t, '01700000003');
    const body = jpeg(4);
    const { mediaId, put } = await uploadSelfie(fs, body);
    expect(put.statusCode).toBe(200);
    await fs.post(`/media/${mediaId}/confirm`);
    const ev = await fs.post('/attendance/events', { clientId: randomUUID(), type: 'work_in', at: '2026-11-16T03:05:00Z', geo: { lat: 22.7, lng: 90.37, accuracyM: 8, mock: false }, selfieMediaId: mediaId });
    expect(ev.status).toBe(201);
    expect(ev.body.flags).not.toContain('no_selfie');
    const pts = await fs.post('/location/points', { deviceId: 'dev-01700000003', points: [{ t: '2026-11-16T03:08:00Z', lat: 22.7, lng: 90.37, acc: 10 }] });
    expect(pts.body.accepted).toBe(1);
    const bm = await as(t, '01700000002');
    const live = await bm.get(`/location/latest?branchId=${s.branchA}`);
    expect(live.body.map((m: { userId: string }) => m.userId)).toContain(s.fs1.id);
  });

  it('a work-in sent before its photo counts at once; the photo is linked after it (attendance_selfie, 1.21.0)', async () => {
    t.clock.set('2026-11-17T03:10:00Z'); // 09:10 Dhaka, a fresh day
    const fs = await as(t, '01700000003');
    const mut = (entity: string, payload: Record<string, unknown>, dependsOn?: string[]) => ({ mutationId: randomUUID(), entity, op: 'create', payload, ...(dependsOn ? { dependsOn } : {}) });
    const push = (c: typeof fs, mutations: unknown[], deviceId = 'dev-01700000003') => c.post('/sync/push', { deviceId, mutations });
    const event = mut('attendance_event', { clientId: randomUUID(), type: 'work_in', at: '2026-11-17T03:05:00Z', geo: { lat: 22.7, lng: 90.37, accuracyM: 8, mock: false } });
    const eventId = (event.payload as { clientId: string }).clientId;
    const first = await push(fs, [event]);
    expect(first.status).toBe(200);
    expect(first.body.results[0].result).toBe('applied');
    expect((await fs.post('/location/points', { deviceId: 'dev-01700000003', points: [{ t: '2026-11-17T03:08:00Z', lat: 22.7, lng: 90.37, acc: 10 }] })).body.accepted).toBe(1);
    const sa = await as(t, '01700000001');
    const flagsOf = async () => ((await sa.get(`/attendance/events?userId=${s.fs1.id}&date=2026-11-17`)).body as { selfieMediaId: string | null; flags: string[] }[])[0]!;
    expect((await flagsOf()).flags).toContain('no_selfie');

    const body = jpeg(5);
    const { mediaId } = await uploadSelfie(fs, body);
    await fs.post(`/media/${mediaId}/confirm`);
    const attach = mut('attendance_selfie', { eventClientId: eventId, selfieMediaId: mediaId }, [event.mutationId]);
    const linked = await push(fs, [attach]);
    expect(linked.body.results[0].result).toBe('applied');
    expect(await flagsOf()).toMatchObject({ selfieMediaId: mediaId });
    expect((await flagsOf()).flags).not.toContain('no_selfie');
    expect((await push(fs, [attach])).body.results[0].result).toBe('replayed'); // replay is harmless

    // a second photo never replaces the first; somebody else's photo or event is refused
    const { mediaId: later } = await uploadSelfie(fs, jpeg(6));
    await push(fs, [mut('attendance_selfie', { eventClientId: eventId, selfieMediaId: later })]);
    expect((await flagsOf()).selfieMediaId).toBe(mediaId);
    const fs2 = await as(t, '01700000004');
    const { mediaId: theirs } = await uploadSelfie(fs2, jpeg(7));
    expect((await push(fs, [mut('attendance_selfie', { eventClientId: eventId, selfieMediaId: theirs })])).body.results[0].result).toBe('rejected');
    expect((await push(fs2, [mut('attendance_selfie', { eventClientId: eventId, selfieMediaId: theirs })], 'dev-01700000004')).body.results[0].result).toBe('rejected');
    expect((await push(fs, [mut('attendance_selfie', { eventClientId: 'not-a-uuid', selfieMediaId: mediaId })])).body.results[0].result).toBe('rejected');
  });
});
