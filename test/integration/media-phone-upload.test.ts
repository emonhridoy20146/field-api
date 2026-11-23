import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { CloudinaryClient, CloudinaryStorage, cloudinary, setCloudinary, setStorage, type FetchLike } from '../../src/core/storage/index.js';
import { storageSecret } from '../../src/core/storage/db-storage.js';
import { MediaModel } from '../../src/modules/media/models/media.model.js';

/**
 * 1.45.0 owner report: staff app photos stay "upload pending" (live: storage cloudinary). This replays the phone's
 * requests byte for byte as staff-app lib/core/media/media.dart sends them behind Vercel's proxy:
 *  - POST /media/upload-url with `capturedAt` = drift's local DateTime `.toIso8601String()`: no `Z`, no offset;
 *  - PUT to the absolute uploadUrl with no Authorization (skipAuth), X-Client, Content-Length, Content-Type image/jpeg;
 *  - POST /media/{id}/confirm with no body and no Content-Type.
 * Before the fix the first call answered 400 VALIDATION_FAILED (capturedAt), so the PUT never happened.
 */
let t: TestApp;
let s: Seeded;
const fetch: FetchLike = async (url, init) => {
  if (url.endsWith('/image/upload')) return { ok: true, status: 200, json: async () => ({ public_id: String((init?.body as FormData).get('public_id')), version: 1, bytes: 10, format: 'jpg' }) };
  return { ok: false, status: 404, json: async () => ({}) };
};
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40_000, 7), Buffer.from([0xff, 0xd9])]);
const sha = createHash('sha256').update(jpeg).digest('hex');
const phone = { 'x-client': 'staff-app/1.0.0 (Pixel 7)', 'accept-language': 'bn', 'x-forwarded-host': 'howlader-apps-api.vercel.app', 'x-forwarded-proto': 'https' };

beforeAll(async () => {
  t = await createTestApp({ now: '2026-11-23T10:15:00Z', env: { STORAGE_DRIVER: 'cloudinary' } });
  s = await seedBasics(t);
  const cfg = t.ctx.config;
  setStorage(new CloudinaryStorage({ baseUrl: 'http://localhost:4000', secret: storageSecret(cfg.JWT_PRIVATE_KEY), now: () => t.clock.now(), cloud: cloudinary, legacy: null }));
  setCloudinary(new CloudinaryClient({ cloudName: 'demo', apiKey: 'k', apiSecret: 's', folder: 'fos', now: () => t.clock.now(), fetch }));
});
afterAll(async () => {
  setCloudinary(null);
  await t.close();
});

describe('phone photo upload end to end (1.45.0)', () => {
  it('presign accepts the offset-less capturedAt the app sends, PUT and confirm succeed, the photo is uploaded', async () => {
    const c = await as(t, '01700000003');
    const r = await c.post('/media/upload-url', { kind: 'selfie', contentType: 'image/jpeg', sizeBytes: jpeg.length, sha256: sha, capturedAt: '2026-11-23T16:12:05.000' }, phone);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expectConforms('POST', '/api/v1/media/upload-url', 201, r.body);
    // The link points at the public host the phone used, over https, never localhost.
    const u = new URL(r.body.uploadUrl as string);
    expect(u.origin).toBe('https://howlader-apps-api.vercel.app');
    expect(u.pathname).toBe('/api/v1/storage/o');
    expect(r.body.headers).toEqual({ 'Content-Type': 'image/jpeg' });

    const put = await t.app.inject({ method: 'PUT', url: `${u.pathname}${u.search}`, headers: { ...phone, ...r.body.headers, 'content-type': 'image/jpeg', 'content-length': String(jpeg.length) }, payload: jpeg });
    expect(put.statusCode, put.body).toBe(200);

    const conf = await t.app.inject({ method: 'POST', url: `/api/v1/media/${r.body.mediaId}/confirm`, headers: { ...phone, 'x-device-id': 'dev-01700000003', authorization: `Bearer ${await token()}` } });
    expect(conf.statusCode, conf.body).toBe(200);
    const m = await MediaModel.findById(r.body.mediaId).lean();
    expect(m?.status).toBe('uploaded');
    expect(m?.capturedAt?.toISOString()).toBe('2026-11-23T10:12:05.000Z'); // Dhaka 16:12 = 10:12 UTC
    expect(m?.cloud?.publicId).toBe(`fos/selfie/${s.fs1.id}/${sha}`);
  });

  it('still refuses a capturedAt that is not a date-time', async () => {
    const c = await as(t, '01700000003');
    const r = await c.post('/media/upload-url', { kind: 'selfie', contentType: 'image/jpeg', sizeBytes: 10, sha256: 'a'.repeat(64), capturedAt: 'yesterday' });
    expect(r.status).toBe(400);
  });
});

async function token(): Promise<string> {
  const { login } = await import('../helpers/app.js');
  return (await login(t.app, '01700000003')).accessToken as string;
}
