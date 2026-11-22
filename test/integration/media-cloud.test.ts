import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { CloudinaryClient, setCloudinary, storage, type FetchLike, type MemoryStorage } from '../../src/core/storage/index.js';
import { dispatchOutbox, OutboxModel } from '../../src/core/events/outbox.js';
import { MediaModel } from '../../src/modules/media/models/media.model.js';
import { AuditLogModel } from '../../src/modules/audit/models/audit-log.model.js';

// ADR-050 / FR-MED-002..004: photos copied to Cloudinary (mocked fetch, no network), the base store as fallback, and
// admin deletion of previous months and of one staff member's attendance photos of a day.
let t: TestApp;
let s: Seeded;
const mem = () => storage() as MemoryStorage;

interface Call {
  url: string;
  method: string;
}
const cloud = { calls: [] as Call[], failUpload: false, failDelete: false, stored: new Set<string>() };
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
    if (cloud.failDelete) return { ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) };
    for (const id of new URL(url).searchParams.getAll('public_ids[]')) cloud.stored.delete(id);
    return { ok: true, status: 200, json: async () => ({ deleted: {} }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
const useCloud = () => setCloudinary(new CloudinaryClient({ cloudName: 'demo', apiKey: 'key1', apiSecret: 'sec1', folder: 'fos', now: () => t.clock.now(), fetch }));

const geo = { lat: 22.7, lng: 90.37, accuracyM: 8 };
let n = 0;
async function photo(c: Awaited<ReturnType<typeof as>>, ownerId: string, kind = 'selfie') {
  const body = Buffer.from(`jpeg-${++n}-${randomUUID()}`);
  const sha = createHash('sha256').update(body).digest('hex');
  const r = await c.post('/media/upload-url', { kind, contentType: 'image/jpeg', sizeBytes: body.length, sha256: sha });
  expect(r.status).toBe(201);
  const key = `${kind}/${ownerId}/${sha}.jpg`;
  await mem().put(key, body, 'image/jpeg'); // what the phone's presigned PUT does
  expect((await c.post(`/media/${r.body.mediaId}/confirm`)).status).toBe(200);
  return { id: r.body.mediaId as string, key, body };
}
const later = (sec: number) => t.clock.set(new Date(t.clock.now().getTime() + sec * 1000).toISOString());

beforeAll(async () => {
  t = await createTestApp({ now: '2026-10-20T04:00:00Z' }); // 10:00 Dhaka, a month earlier than the purge tests
  s = await seedBasics(t);
});
afterAll(async () => {
  setCloudinary(null);
  await t.close();
});

describe('photos in Cloudinary (FR-MED-002, ADR-050)', () => {
  it('without Cloudinary the base store keeps and serves the photo; health says none', async () => {
    setCloudinary(null);
    const fs = await as(t, '01700000003');
    const p = await photo(fs, s.fs1.id);
    expect(await OutboxModel.countDocuments({ type: 'media.cloud_copy' })).toBe(0);
    const url = await fs.get(`/media/${p.id}/url`);
    expect(url.status).toBe(200);
    expect(url.body.url).toMatch(/^memory:\/\/get\//);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/system/health' })).json().cloudStorage).toBe('none');
  });

  it('confirm never waits for Cloudinary; an outage is retried; then the base copy is removed and reads are signed Cloudinary links', async () => {
    useCloud();
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/system/health' })).json().cloudStorage).toBe('cloudinary');
    cloud.failUpload = true;
    const fs = await as(t, '01700000003');
    const p = await photo(fs, s.fs1.id); // confirm is 200 although Cloudinary is down
    let st = await dispatchOutbox();
    expect(st.retried).toBe(1);
    const fallback = await fs.get(`/media/${p.id}/url`);
    expect(fallback.body.url).toMatch(/^memory:\/\/get\//); // fallback while not copied
    expect(mem().objects.has(p.key)).toBe(true);

    cloud.failUpload = false;
    later(31);
    st = await dispatchOutbox();
    expect(st.done).toBe(1);
    const row = await MediaModel.findById(p.id).lean();
    expect(row!.cloud).toMatchObject({ provider: 'cloudinary', publicId: `fos/selfie/${s.fs1.id}/${p.key.split('/')[2]!.replace('.jpg', '')}`, bytes: 1234, format: 'jpg' });
    expect(row!.baseRemovedAt).toBeTruthy();
    expect(mem().objects.has(p.key)).toBe(false); // hosting space freed

    const sa = await as(t, '01700000001');
    const r = await sa.get(`/media/${p.id}/url`);
    expect(r.status).toBe(200);
    expectConforms('GET', `/media/${p.id}/url`, 200, r.body);
    const u = new URL(r.body.url as string);
    expect(`${u.origin}${u.pathname}`).toBe('https://api.cloudinary.com/v1_1/demo/image/download');
    expect(u.searchParams.get('type')).toBe('authenticated');
    expect(Number(u.searchParams.get('expires_at')) - Number(u.searchParams.get('timestamp'))).toBe(300);
    expect(u.searchParams.get('signature')).toMatch(/^[a-f0-9]{40}$/);
    expect(r.body.url).not.toContain('sec1');
    expect(new Date(r.body.expiresAt as string).getTime() - t.clock.now().getTime()).toBe(300_000);
  });

  it('voice notes are not copied', async () => {
    const fs = await as(t, '01700000003');
    const before = await OutboxModel.countDocuments({ type: 'media.cloud_copy' });
    const body = Buffer.from(`voice-${randomUUID()}`);
    const sha = createHash('sha256').update(body).digest('hex');
    const r = await fs.post('/media/upload-url', { kind: 'voice_note', contentType: 'audio/aac', sizeBytes: body.length, sha256: sha });
    await mem().put(`voice_note/${s.fs1.id}/${sha}.aac`, body, 'audio/aac');
    expect((await fs.post(`/media/${r.body.mediaId}/confirm`)).status).toBe(200);
    expect(await OutboxModel.countDocuments({ type: 'media.cloud_copy' })).toBe(before);
  });
});

describe('attendance photos of a day (FR-MED-004)', () => {
  let ids: string[] = [];
  it('an admin deletes them: removed from Cloudinary and the base store, the log stays on each event', async () => {
    t.clock.set('2026-10-21T03:00:00Z'); // 09:00 Dhaka
    useCloud();
    const fs = await as(t, '01700000003');
    const a = await photo(fs, s.fs1.id);
    const b = await photo(fs, s.fs1.id);
    await dispatchOutbox(); // copy both to Cloudinary
    const c = await photo(fs, s.fs1.id); // not copied yet: still only in the base store
    ids = [a.id, b.id, c.id];
    expect((await fs.post('/attendance/events', { clientId: randomUUID(), type: 'work_in', at: '2026-10-21T03:00:00Z', geo, selfieMediaId: a.id })).status).toBe(201);
    expect((await fs.post('/attendance/events', { clientId: randomUUID(), type: 'break_start', at: '2026-10-21T05:00:00Z', geo, selfieMediaId: b.id })).status).toBe(201);
    expect((await fs.post('/attendance/events', { clientId: randomUUID(), type: 'work_out', at: '2026-10-21T06:00:00Z', geo, selfieMediaId: c.id })).status).toBe(201);
    expect(cloud.stored.size).toBeGreaterThanOrEqual(2);

    const bm = await as(t, '01700000002');
    expect((await bm.post('/attendance/photos/delete', { userId: s.fs1.id, date: '2026-10-21' })).status).toBe(403); // no media.delete by default

    const sa = await as(t, '01700000001');
    later(60);
    const r = await sa.post('/attendance/photos/delete', { userId: s.fs1.id, date: '2026-10-21', reason: 'privacy request' });
    expect(r.status).toBe(200);
    expectConforms('POST', '/attendance/photos/delete', 200, r.body);
    expect(r.body.deleted).toBe(3);
    for (const e of r.body.events) {
      expect(e.selfieMediaId).toBeNull();
      expect(e.selfieDeleted).toMatchObject({ by: s.sa.id, byName: 'Owner', at: t.clock.now().toISOString() });
    }
    const list = await sa.get(`/attendance/events?userId=${s.fs1.id}&date=2026-10-21`);
    expectConforms('GET', '/attendance/events', 200, list.body);
    expect(list.body.every((e: { selfieDeleted: unknown }) => !!e.selfieDeleted)).toBe(true);

    // Both stores are clean at once; the outbox item was not needed.
    for (const p of [a, b, c]) expect(mem().objects.has(p.key)).toBe(false);
    for (const id of [a.id, b.id]) {
      const row = await MediaModel.findById(id).lean();
      expect(cloud.stored.has(row!.cloud!.publicId!)).toBe(false);
    }
    const rows = await MediaModel.find({ _id: { $in: ids } }).lean();
    expect(rows.every((m) => m.status === 'deleted' && m.deleted?.scope === 'attendance_day' && m.deleted.filesRemovedAt)).toBe(true);
    expect(await OutboxModel.countDocuments({ type: 'media.remote_delete', status: { $in: ['pending', 'processing'] } })).toBe(0);

    // The copy job of the third photo finds it deleted and does nothing.
    later(5);
    await dispatchOutbox();
    expect((await MediaModel.findById(c.id).lean())!.cloud).toBeNull();

    const gone = await sa.get(`/media/${a.id}/url`);
    expect(gone.status).toBe(404);
    expect(gone.body.details).toMatchObject({ reason: 'MEDIA_DELETED', deletedByName: 'Owner' });
    expect(await AuditLogModel.countDocuments({ action: 'attendance.photos_deleted', entityId: `${s.fs1.id}:2026-10-21` })).toBe(1);

    // The phone's queue cannot bring a deleted photo back.
    const again = await fs.post('/media/upload-url', { kind: 'selfie', contentType: 'image/jpeg', sizeBytes: a.body.length, sha256: createHash('sha256').update(a.body).digest('hex') });
    expect(again.status).toBe(409);
    expect(again.body.details.reason).toBe('MEDIA_DELETED');

    // Repeating answers 0 and keeps the log.
    const twice = await sa.post('/attendance/photos/delete', { userId: s.fs1.id, date: '2026-10-21' });
    expect(twice.body.deleted).toBe(0);
    expect(twice.body.events[0].selfieDeleted.byName).toBe('Owner');
  });

  it('branch scope: out of scope is 404; a failed Cloudinary delete is retried by the outbox', async () => {
    t.clock.set('2026-10-22T03:00:00Z');
    const sa = await as(t, '01700000001');
    await sa.put(`/rbac/overrides/user/${s.bm.id}`, { changes: [{ key: 'media.delete', effect: 'allow' }], reason: 'Test: manager deletes photos' });
    const fsB = await as(t, '01700000005');
    const pb = await photo(fsB, s.fsB.id);
    await fsB.post('/attendance/events', { clientId: randomUUID(), type: 'work_in', at: '2026-10-22T03:00:00Z', geo, selfieMediaId: pb.id });
    const bm = await as(t, '01700000002');
    const out = await bm.post('/attendance/photos/delete', { userId: s.fsB.id, date: '2026-10-22' });
    expect(out.status).toBe(404); // branch B is not the manager's
    expect((await bm.post('/attendance/photos/delete', { userId: 'not-an-id', date: '2026-10-22' })).status).toBe(404);
    expect((await bm.post('/attendance/photos/delete', { userId: s.fsB.id, date: '22-10-2026' })).status).toBe(400);

    useCloud();
    await dispatchOutbox(); // copy to Cloudinary
    expect((await MediaModel.findById(pb.id).lean())!.cloud).toBeTruthy();
    cloud.failDelete = true;
    const r = await sa.post('/attendance/photos/delete', { userId: s.fsB.id, date: '2026-10-22' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.deleted).toBe(1); // marked deleted at once
    expect((await sa.get(`/media/${pb.id}/url`)).status).toBe(404);
    expect((await MediaModel.findById(pb.id).lean())!.deleted!.filesRemovedAt).toBeNull();
    cloud.failDelete = false;
    later(31);
    const st = await dispatchOutbox();
    expect(st.done).toBeGreaterThanOrEqual(1);
    const row = await MediaModel.findById(pb.id).lean();
    expect(row!.deleted!.filesRemovedAt).toBeTruthy();
    expect(cloud.stored.has(row!.cloud!.publicId!)).toBe(false);
  });
});

describe('delete the photos of previous months (FR-MED-003)', () => {
  let monthProof: string;
  it('preview per month, alert from the 5th, money proofs only when asked', async () => {
    t.clock.set('2026-10-23T04:00:00Z');
    const fs = await as(t, '01700000003');
    await photo(fs, s.fs1.id, 'visit_photo');
    monthProof = (await photo(fs, s.fs1.id, 'deposit_slip')).id;
    // Older rows straight into the collection (200+ to see the batches): September, branch A and B.
    const sept = new Date('2026-09-10T04:00:00Z');
    const rows = Array.from({ length: 205 }, (_, i) => ({ ownerId: s.fs2.id, branchId: s.branchA, kind: 'visit_photo', contentType: 'image/jpeg', sizeBytes: 100, sha256: `${i}`.padStart(64, 'b'), key: `visit_photo/${s.fs2.id}/${i}.jpg`, status: 'uploaded', createdAt: sept }));
    rows.push({ ownerId: s.fsB.id, branchId: s.branchB, kind: 'selfie', contentType: 'image/jpeg', sizeBytes: 50, sha256: 'c'.repeat(64), key: `selfie/${s.fsB.id}/c.jpg`, status: 'uploaded', createdAt: sept });
    await MediaModel.insertMany(rows);

    t.clock.set('2026-11-04T04:00:00Z'); // the 4th: nothing suggested yet
    let sa = await as(t, '01700000001');
    let p = await sa.get('/media/purge/preview');
    expect(p.status).toBe(200);
    expectConforms('GET', '/media/purge/preview', 200, p.body);
    expect(p.body.before).toBe('2026-11');
    expect(p.body.cutoff).toBe('2026-10-31T18:00:00.000Z'); // Dhaka midnight of the 1st
    expect(p.body.suggest).toBe(false);
    expect(p.body.months.map((m: { month: string }) => m.month)).toEqual(['2026-09', '2026-10']);
    expect(p.body.months[0]).toEqual({ month: '2026-09', count: 206, bytes: 205 * 100 + 50 });
    const noProofs = p.body.total.count as number;
    t.clock.set('2026-11-05T04:00:00Z');
    sa = await as(t, '01700000001'); // a new day, a new token
    p = await sa.get('/media/purge/preview');
    expect(p.body.suggest).toBe(true);
    const withProofs = await sa.get('/media/purge/preview?includeMoneyProofs=true');
    expect(withProofs.body.total.count).toBe(noProofs + 1);
    expect(withProofs.body.kinds).toContain('deposit_slip');
    expect((await sa.get('/media/purge/preview?before=2026-12')).status).toBe(422);
    expect((await sa.get('/media/purge/preview?before=2026-1')).status).toBe(400);
    expect((await (await as(t, '01700000006')).get('/media/purge/preview')).status).toBe(403); // viewer
    expect((await (await as(t, '01700000003')).get('/media/purge/preview')).status).toBe(403); // staff

    const bm = await as(t, '01700000002'); // granted media.delete above; sees branch A only
    const bmp = await bm.get('/media/purge/preview?before=2026-10');
    expect(bmp.body.total.count).toBe(205);
  });

  it('needs the exact confirmation text; deletes 200 per call until nothing remains; audited per call', async () => {
    const sa = await as(t, '01700000001');
    const wrong = await sa.post('/media/purge', { before: '2026-11', confirmText: 'delete 2026-11' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.details.rule).toBe('CONFIRM_TEXT_MISMATCH');
    expect(await MediaModel.countDocuments({ status: 'deleted', 'deleted.scope': 'purge' })).toBe(0);
    expect((await sa.post('/media/purge', { before: '2026-12', confirmText: 'DELETE 2026-12' })).status).toBe(422);

    const first = await sa.post('/media/purge', { before: '2026-11', confirmText: 'DELETE 2026-11' });
    expect(first.status).toBe(200);
    expectConforms('POST', '/media/purge', 200, first.body);
    expect(first.body.deleted).toBe(200);
    expect(first.body.remaining).toBeGreaterThan(0);
    let remaining = first.body.remaining as number;
    let calls = 1;
    while (remaining > 0) {
      const r = await sa.post('/media/purge', { before: '2026-11', confirmText: 'DELETE 2026-11' });
      remaining = r.body.remaining as number;
      calls++;
    }
    expect(calls).toBe(2);
    expect((await sa.get('/media/purge/preview')).body.total.count).toBe(0);
    expect((await sa.get('/media/purge/preview')).body.suggest).toBe(false);
    expect(await AuditLogModel.countDocuments({ action: 'media.purged' })).toBe(2);
    // The deposit slip (money proof) is kept unless asked; this month's photos are never touched.
    expect((await MediaModel.findById(monthProof).lean())!.status).toBe('uploaded');
    expect(await MediaModel.countDocuments({ createdAt: { $gte: new Date('2026-10-31T18:00:00Z') }, status: 'deleted' })).toBe(0);
    // Files removed from the base store; rows never copied to Cloudinary need no Cloudinary call.
    expect([...mem().objects.keys()].filter((k) => k.startsWith(`visit_photo/${s.fs1.id}/`))).toEqual([]);
    const all = await MediaModel.find({ 'deleted.scope': 'purge' }).lean();
    expect(all.every((m) => m.deleted?.filesRemovedAt)).toBe(true);

    const proofs = await sa.post('/media/purge', { before: '2026-11', includeMoneyProofs: true, confirmText: 'DELETE 2026-11' });
    expect(proofs.body).toMatchObject({ deleted: 1, remaining: 0 });
    expect((await MediaModel.findById(monthProof).lean())!.status).toBe('deleted');
  });
});
