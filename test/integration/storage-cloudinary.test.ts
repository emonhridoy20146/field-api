import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { loadConfig } from '../../src/core/config/index.js';
import { db } from '../../src/core/db/index.js';
import { dispatchOutbox, OutboxModel } from '../../src/core/events/outbox.js';
import { CLOUD_RECORDS, CloudinaryClient, CloudinaryStorage, MemoryStorage, cloudinary, setCloudinary, setStorage, storage, storageDriver, storageFromConfig, type FetchLike } from '../../src/core/storage/index.js';
import { storageSecret } from '../../src/core/storage/db-storage.js';
import { MediaModel } from '../../src/modules/media/models/media.model.js';

// ADR-053: STORAGE_DRIVER=cloudinary. The phone PUTs to the API's signed link as with the MongoDB store; the API puts the
// photo in Cloudinary at once (mocked fetch, no network), falls back to MongoDB when Cloudinary fails, and old photos in
// the previous store (S3; a memory store stands in for it here) stay readable and deletable.
let t: TestApp;
let s: Seeded;
let legacy: MemoryStorage;

const cloud = { calls: [] as { url: string; method: string }[], failUpload: false, stored: new Set<string>() };
const fetch: FetchLike = async (url, init) => {
  const method = init?.method ?? 'GET';
  cloud.calls.push({ url, method });
  if (url.endsWith('/image/upload')) {
    if (cloud.failUpload) return { ok: false, status: 503, json: async () => ({ error: { message: 'unavailable' } }) };
    const publicId = String((init?.body as FormData).get('public_id'));
    cloud.stored.add(publicId);
    return { ok: true, status: 200, json: async () => ({ public_id: publicId, version: 1732250000, bytes: 1234, format: 'jpg' }) };
  }
  if (method === 'DELETE') {
    for (const id of new URL(url).searchParams.getAll('public_ids[]')) cloud.stored.delete(id);
    return { ok: true, status: 200, json: async () => ({ deleted: {} }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
const uploads = () => cloud.calls.filter((c) => c.url.endsWith('/image/upload')).length;
const deletes = () => cloud.calls.filter((c) => c.method === 'DELETE');

const jpeg = (n: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1_500 + n, n % 251), Buffer.from([0xff, 0xd9])]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const pathOf = (url: string) => {
  const u = new URL(url);
  expect(u.pathname).toBe('/api/v1/storage/o');
  return `${u.pathname}${u.search}`;
};
const local = (key: string) => db().collection('storage_objects').findOne({ _id: key as never });
const record = (key: string) => db().collection(CLOUD_RECORDS).findOne({ _id: key as never });

// Every upload here is by field staff 1 (01700000003).
async function upload(c: Awaited<ReturnType<typeof as>>, body: Buffer, kind = 'selfie', contentType = 'image/jpeg') {
  const r = await c.post('/media/upload-url', { kind, contentType, sizeBytes: body.length, sha256: sha(body) });
  expect(r.status).toBe(201);
  const put = await t.app.inject({ method: 'PUT', url: pathOf(r.body.uploadUrl as string), headers: { 'content-type': contentType }, payload: body });
  const ext = contentType === 'audio/aac' ? 'aac' : 'jpg';
  return { id: r.body.mediaId as string, put, key: `${kind}/${s.fs1.id}/${sha(body)}.${ext}`, url: r.body.uploadUrl as string };
}

beforeAll(async () => {
  t = await createTestApp({ now: '2026-10-20T04:00:00Z', env: { STORAGE_DRIVER: 'cloudinary' } });
  s = await seedBasics(t);
  legacy = new MemoryStorage();
  const cfg = t.ctx.config;
  setStorage(new CloudinaryStorage({ baseUrl: cfg.PUBLIC_BASE_URL, secret: storageSecret(cfg.JWT_PRIVATE_KEY), now: () => t.clock.now(), cloud: cloudinary, legacy }));
  setCloudinary(new CloudinaryClient({ cloudName: 'demo', apiKey: 'key1', apiSecret: 'sec1', folder: 'fos', now: () => t.clock.now(), fetch }));
});
afterAll(async () => {
  setCloudinary(null);
  await t.close();
});

describe('driver choice (ADR-053)', () => {
  const cl = { CLOUDINARY_CLOUD_NAME: 'demo', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's' };
  it('on Vercel with Cloudinary configured it is Cloudinary first; S3 only with both keys', () => {
    expect(storageDriver(loadConfig({ NODE_ENV: 'test', STORAGE_DRIVER: 'cloudinary' }))).toBe('cloudinary');
    expect(storageDriver(loadConfig({ NODE_ENV: 'staging', VERCEL: '1', ...cl }))).toBe('cloudinary');
    const keys = { S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 'b' };
    expect(storageDriver(loadConfig({ NODE_ENV: 'staging', VERCEL: '1', ...keys, ...cl }))).toBe('cloudinary');
    expect(storageDriver(loadConfig({ NODE_ENV: 'staging', VERCEL: '1', STORAGE_DRIVER: 's3', ...cl }))).toBe('cloudinary'); // leftover s3 without keys
    expect(storageDriver(loadConfig({ NODE_ENV: 'staging', VERCEL: '1', STORAGE_DRIVER: 's3', ...keys, ...cl }))).toBe('s3'); // real S3 asked for
    expect(storageDriver(loadConfig({ NODE_ENV: 'staging', VERCEL: '1', S3_ENDPOINT: 'https://r2.example.test', ...cl }))).toBe('cloudinary');
    expect(storageDriver(loadConfig({ NODE_ENV: 'staging', VERCEL: '1', ...keys }))).toBe('s3'); // no Cloudinary: as before
    expect(storageDriver(loadConfig({ NODE_ENV: 'staging', ...keys, ...cl }))).toBe('s3'); // not Vercel: unchanged
  });

  it('keeps the S3 reader for old photos only when S3 is still configured', () => {
    const now = () => new Date();
    const withS3 = storageFromConfig(loadConfig({ NODE_ENV: 'test', STORAGE_DRIVER: 'cloudinary', S3_ENDPOINT: 'https://r2.example.test', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 'b' }), now);
    expect(withS3).toBeInstanceOf(CloudinaryStorage);
    expect((withS3 as CloudinaryStorage).legacy).not.toBeNull();
    expect((storageFromConfig(loadConfig({ NODE_ENV: 'test', STORAGE_DRIVER: 'cloudinary' }), now) as CloudinaryStorage).legacy).toBeNull();
  });

  it('health says cloudinary', async () => {
    const h = (await t.app.inject({ method: 'GET', url: '/api/v1/system/health' })).json();
    expect(h).toMatchObject({ storage: 'cloudinary', cloudStorage: 'cloudinary' });
    expectConforms('GET', '/system/health', 200, h);
  });
});

describe('the phone uploads straight to Cloudinary (FR-MED-005)', () => {
  it('PUT goes to Cloudinary at once; confirm takes it over without a copy job; reads are signed Cloudinary links', async () => {
    const fs = await as(t, '01700000003');
    const before = uploads();
    const p = await upload(fs, jpeg(1));
    expect(p.put.statusCode).toBe(200);
    expectConforms('PUT', '/storage/o', 200, p.put.json());
    expect(uploads()).toBe(before + 1);
    expect(await local(p.key)).toBeNull(); // nothing kept in MongoDB
    expect(await record(p.key)).toMatchObject({ publicId: `fos/selfie/${s.fs1.id}/${sha(jpeg(1))}` });

    expect((await fs.post(`/media/${p.id}/confirm`)).body.status).toBe('uploaded');
    const row = await MediaModel.findById(p.id).lean();
    expect(row!.cloud).toMatchObject({ provider: 'cloudinary', publicId: `fos/selfie/${s.fs1.id}/${sha(jpeg(1))}`, format: 'jpg' });
    expect(row!.baseRemovedAt).toBeTruthy();
    expect(await OutboxModel.countDocuments({ type: 'media.cloud_copy' })).toBe(0);
    expect(await record(p.key)).toBeNull(); // the row owns it now

    const r = await (await as(t, '01700000001')).get(`/media/${p.id}/url`);
    expect(r.status).toBe(200);
    const u = new URL(r.body.url as string);
    expect(`${u.origin}${u.pathname}`).toBe('https://api.cloudinary.com/v1_1/demo/image/download');
    expect(u.searchParams.get('type')).toBe('authenticated');
    expect(Number(u.searchParams.get('expires_at')) - Number(u.searchParams.get('timestamp'))).toBe(300);
  });

  it('the signed checks still apply: a body that differs never reaches Cloudinary', async () => {
    const fs = await as(t, '01700000003');
    const body = jpeg(2);
    const r = await fs.post('/media/upload-url', { kind: 'selfie', contentType: 'image/jpeg', sizeBytes: body.length, sha256: sha(body) });
    const before = uploads();
    const bad = await t.app.inject({ method: 'PUT', url: pathOf(r.body.uploadUrl as string), headers: { 'content-type': 'image/jpeg' }, payload: jpeg(3) });
    expect(bad.statusCode).toBe(400);
    expect((await t.app.inject({ method: 'PUT', url: '/api/v1/storage/o?t=x.y', headers: { 'content-type': 'image/jpeg' }, payload: body })).statusCode).toBe(403);
    expect(uploads()).toBe(before);
    expect((await fs.post(`/media/${r.body.mediaId}/confirm`)).status).toBe(409); // NOT_UPLOADED
  });

  it('Cloudinary down: the upload still succeeds into MongoDB; confirm queues the copy; it moves once Cloudinary is back', async () => {
    cloud.failUpload = true;
    const fs = await as(t, '01700000003');
    const p = await upload(fs, jpeg(4));
    expect(p.put.statusCode).toBe(200);
    expect(await local(p.key)).toBeTruthy();
    expect(await record(p.key)).toBeNull();
    expect((await fs.post(`/media/${p.id}/confirm`)).body.status).toBe('uploaded');
    expect(await OutboxModel.countDocuments({ type: 'media.cloud_copy' })).toBe(1);
    const fallback = await fs.get(`/media/${p.id}/url`);
    expect(pathOf(fallback.body.url as string)).toMatch(/^\/api\/v1\/storage\/o\?t=/); // the MongoDB store's signed GET
    const got = await t.app.inject({ method: 'GET', url: pathOf(fallback.body.url as string) });
    expect(Buffer.compare(got.rawPayload, jpeg(4))).toBe(0);

    cloud.failUpload = false;
    const st = await dispatchOutbox(); // what /api/cron does
    expect(st.done).toBe(1);
    const row = await MediaModel.findById(p.id).lean();
    expect(row!.cloud?.publicId).toBe(`fos/selfie/${s.fs1.id}/${sha(jpeg(4))}`);
    expect(await local(p.key)).toBeNull();
    expect(new URL((await fs.get(`/media/${p.id}/url`)).body.url as string).hostname).toBe('api.cloudinary.com');
  });

  it('a retried PUT after a fallback lands in Cloudinary and clears the MongoDB copy', async () => {
    cloud.failUpload = true;
    const fs = await as(t, '01700000003');
    const p = await upload(fs, jpeg(5));
    expect(await local(p.key)).toBeTruthy();
    cloud.failUpload = false;
    const again = await t.app.inject({ method: 'PUT', url: pathOf(p.url), headers: { 'content-type': 'image/jpeg' }, payload: jpeg(5) });
    expect(again.statusCode).toBe(200);
    expect(await local(p.key)).toBeNull();
    expect(await record(p.key)).toBeTruthy();
    const copies = await OutboxModel.countDocuments({ type: 'media.cloud_copy' });
    await fs.post(`/media/${p.id}/confirm`);
    expect(await OutboxModel.countDocuments({ type: 'media.cloud_copy' })).toBe(copies);
  });

  it('voice notes stay in MongoDB', async () => {
    const fs = await as(t, '01700000003');
    const before = uploads();
    const p = await upload(fs, Buffer.from('voice-bytes-1'), 'voice_note', 'audio/aac');
    expect(p.put.statusCode).toBe(200);
    expect(uploads()).toBe(before);
    expect(await local(p.key)).toBeTruthy();
  });

  it('a photo stored in S3 before the switch stays readable and is copied by the job', async () => {
    const body = jpeg(6);
    const key = `selfie/${s.fs1.id}/${sha(body)}.jpg`;
    await legacy.put(key, body, 'image/jpeg');
    const old = await MediaModel.create({ ownerId: s.fs1.id, branchId: s.branchA, kind: 'selfie', contentType: 'image/jpeg', sizeBytes: body.length, sha256: sha(body), key, status: 'uploaded', createdAt: t.clock.now(), confirmedAt: t.clock.now() });
    const fs = await as(t, '01700000003');
    const r = await fs.get(`/media/${old._id.toHexString()}/url`);
    expect(r.status).toBe(200);
    expect(r.body.url).toBe(`memory://get/${encodeURIComponent(key)}`); // the previous store's link
    expect(await storage().exists(key)).toBe(true);
  });
});

describe('admin deletes remove the file everywhere (FR-MED-003)', () => {
  it('Cloudinary uploads, pending uploads, MongoDB fallbacks and old S3 photos', async () => {
    const fs = await as(t, '01700000003');
    // October photos: one straight in Cloudinary (confirmed), one in Cloudinary never confirmed, one in MongoDB, one in S3.
    const direct = await upload(fs, jpeg(10));
    await fs.post(`/media/${direct.id}/confirm`);
    const pending = await upload(fs, jpeg(11));
    cloud.failUpload = true;
    const inDb = await upload(fs, jpeg(12));
    await fs.post(`/media/${inDb.id}/confirm`);
    cloud.failUpload = false;
    const oldBody = jpeg(13);
    const oldKey = `visit_photo/${s.fs1.id}/${sha(oldBody)}.jpg`;
    await legacy.put(oldKey, oldBody, 'image/jpeg');
    await MediaModel.create({ ownerId: s.fs1.id, branchId: s.branchA, kind: 'visit_photo', contentType: 'image/jpeg', sizeBytes: oldBody.length, sha256: sha(oldBody), key: oldKey, status: 'uploaded', createdAt: t.clock.now() });
    const publicOf = (b: Buffer, kind = 'selfie') => `fos/${kind}/${s.fs1.id}/${sha(b)}`;
    expect(cloud.stored.has(publicOf(jpeg(10)))).toBe(true);
    expect(cloud.stored.has(publicOf(jpeg(11)))).toBe(true);

    // Only the S3 photo may reach the previous store.
    const legacyDeletes: string[] = [];
    const del = legacy.delete.bind(legacy);
    legacy.delete = async (k: string) => {
      legacyDeletes.push(k);
      await del(k);
    };

    t.clock.set('2026-11-06T04:00:00Z');
    const sa = await as(t, '01700000001');
    let remaining = 1;
    while (remaining > 0) {
      const r = await sa.post('/media/purge', { before: '2026-11', confirmText: 'DELETE 2026-11' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      remaining = r.body.remaining as number;
    }
    expect(cloud.stored.has(publicOf(jpeg(10)))).toBe(false);
    expect(cloud.stored.has(publicOf(jpeg(11)))).toBe(false); // the unconfirmed one too
    expect(await record(pending.key)).toBeNull();
    expect(await local(inDb.key)).toBeNull();
    expect(legacy.objects.has(oldKey)).toBe(false);
    expect(legacyDeletes).toContain(oldKey);
    expect(legacyDeletes).not.toContain(direct.key);
    expect(legacyDeletes).not.toContain(inDb.key);
    expect(deletes().length).toBeGreaterThan(0);
    const rows = await MediaModel.find({ 'deleted.scope': 'purge' }).lean();
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.every((m) => m.deleted?.filesRemovedAt)).toBe(true);
  });
});
