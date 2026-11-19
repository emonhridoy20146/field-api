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
const pathOf = (url: string) => {
  expect(url.startsWith(`${BASE}/api/v1/storage/o?t=`)).toBe(true);
  return url.slice(BASE.length);
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
    expect(storageDriver(loadConfig({ NODE_ENV: 'staging', VERCEL: '1', S3_ENDPOINT: 'https://r2.example.test' }))).toBe('s3');
    expect(storageDriver(loadConfig({ NODE_ENV: 'development' }))).toBe('memory');
    expect(storageDriver(loadConfig({ NODE_ENV: 'development', STORAGE_DRIVER: '' }))).toBe('memory');
  });

  it('uses the Vercel production host when PUBLIC_BASE_URL is not set', () => {
    expect(loadConfig({ NODE_ENV: 'staging', VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'fos.example.test' }).PUBLIC_BASE_URL).toBe('https://fos.example.test');
    expect(loadConfig({ NODE_ENV: 'development' }).PUBLIC_BASE_URL).toBe('http://localhost:4000');
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
});
