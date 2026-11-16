import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { applyAssignments, getByErpId } from '../../src/modules/customers/index.js';
import { dispatchOutbox } from '../../src/core/events/outbox.js';
import { storage, type MemoryStorage } from '../../src/core/storage/index.js';
import { snapshotOverdue } from '../../src/modules/reports/trends.js';
import { processExports } from '../../src/modules/reports/exports.js';
import { ExportModel } from '../../src/modules/reports/models/report.model.js';
import { AuditLogModel } from '../../src/modules/audit/models/audit-log.model.js';

let t: TestApp;
let s: Seeded;
const ids: Record<string, string> = {};
const geo = { lat: 22.7106, lng: 90.3703, accuracyM: 9 };
const BM = '01700000002';
const FS1 = '01700000003';
const collect = (c: Awaited<ReturnType<typeof as>>, n: number, amountPoisha: number, method: string, extra: Record<string, unknown> = {}) =>
  c.post('/collections', { clientId: randomUUID(), customerId: ids['100246'], amountPoisha, method, recordedAt: `2026-11-15T03:3${n}:00Z`, receiptNo: `BRL01-FS014-261115-000${n}`, geo, ...extra }, { 'idempotency-key': randomUUID() });

beforeAll(async () => {
  t = await createTestApp(); // Sunday 2026-11-15 10:00 Dhaka
  s = await seedBasics(t);
  await deltaSync();
  for (const e of ['100245', '100246']) ids[e] = (await getByErpId(e))!.id;
  await applyAssignments([
    { customerId: ids['100245']!, assigneeId: s.fs1.id },
    { customerId: ids['100246']!, assigneeId: s.fs1.id },
  ]);
  const fs = await as(t, FS1);
  await fs.post('/attendance/events', { clientId: randomUUID(), type: 'work_in', at: '2026-11-15T03:00:00Z', geo });
  await fs.post('/visits', { clientId: randomUUID(), customerId: ids['100245'], checkInAt: '2026-11-15T03:30:00Z', outcome: 'partial_paid', geo });
  expect((await collect(fs, 1, 150000, 'cash')).status).toBe(201);
  expect((await collect(fs, 2, 50000, 'bkash', { transactionRef: 'BKX1234567' })).status).toBe(201);
  await dispatchOutbox(); // both posted to the mock ERP
  expect((await collect(fs, 3, 20000, 'cash')).status).toBe(201); // still waiting for the worker
  await fs.post('/promises', { clientId: randomUUID(), customerId: ids['100245'], promisedDate: '2026-11-15', promisedAmountPoisha: 100000 });
  await fs.post('/location/points', {
    deviceId: `dev-${FS1}`,
    points: [0, 1, 2, 3].map((i) => ({ t: `2026-11-15T03:1${i}:00Z`, lat: 22.7 + i * 0.002, lng: 90.36, acc: 10 })),
  });
});
afterAll(async () => t.close());

describe('staff performance (FR-REP-001)', () => {
  it('daily and monthly rows equal what was recorded', async () => {
    const bm = await as(t, BM);
    const r = await bm.get('/reports/staff-performance?period=daily&date=2026-11-15');
    expect(r.status).toBe(200);
    expectConforms('GET', '/reports/staff-performance', 200, r.body);
    expect(r.body.map((x: { userId: string }) => x.userId)).toEqual([s.fs1.id, s.fs2.id]); // own branch only, by employee code
    expect(r.body[0]).toMatchObject({
      name: 'Rakib Hasan',
      period: '2026-11-15',
      visits: 1,
      uniqueCustomers: 1,
      collectionsCount: 3,
      collectedPoisha: { cash: 170000, bkash: 50000 },
      targetPoisha: 0,
      promisesDue: 1,
      promisesKept: 0,
      promiseFulfilmentRate: 0,
      presentDays: 1,
      lateDays: 0,
    });
    expect(r.body[0].distanceKm).toBeGreaterThan(0.6);
    expect(r.body[0].fieldMin).toBe(3);
    expect(r.body[1]).toMatchObject({ visits: 0, collectionsCount: 0, collectedPoisha: {}, presentDays: 0, distanceKm: 0 });

    const m = await bm.get(`/reports/staff-performance?period=monthly&date=2026-11&userId=${s.fs1.id}`);
    expectConforms('GET', '/reports/staff-performance', 200, m.body);
    expect(m.body).toHaveLength(1);
    expect(m.body[0]).toMatchObject({ period: '2026-11', collectionsCount: 3, presentDays: 1, visits: 1 });
    expect((await bm.get('/reports/staff-performance?period=daily&date=2026-11-14')).body[0]).toMatchObject({ visits: 0, collectionsCount: 0 });
  });

  it('scope, validation, permissions', async () => {
    const bm = await as(t, BM);
    expect((await bm.get(`/reports/staff-performance?period=daily&date=2026-11-15&userId=${s.fsB.id}`)).status).toBe(404);
    expect((await bm.get(`/reports/staff-performance?period=daily&date=2026-11-15&branchId=${s.branchB}`)).status).toBe(404);
    expect((await bm.get('/reports/staff-performance?period=daily&date=2026-11-16')).status).toBe(400);
    expect((await bm.get('/reports/staff-performance?period=monthly&date=2026-11-15')).status).toBe(400);
    expect((await bm.get('/reports/staff-performance?date=2026-11-15')).status).toBe(400);
    expect((await (await as(t, FS1)).get('/reports/staff-performance?period=daily&date=2026-11-15')).status).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/reports/staff-performance?period=daily&date=2026-11-15' })).statusCode).toBe(401);
    const sa = await as(t, '01700000001');
    const all = await sa.get('/reports/staff-performance?period=daily&date=2026-11-15');
    expect(all.body).toHaveLength(3); // both branches
    expect((await (await as(t, '01700000006')).get('/reports/staff-performance?period=daily&date=2026-11-15')).status).toBe(200); // viewer may read
  });
});

describe('branch trends (FR-REP-002)', () => {
  it('collection trend per day, week and month; overdue from nightly snapshots plus today live', async () => {
    const bm = await as(t, BM);
    const d = await bm.get('/reports/branch-trends?from=2026-11-09&to=2026-11-15');
    expect(d.status).toBe(200);
    expectConforms('GET', '/reports/branch-trends', 200, d.body);
    expect(d.body.collection).toHaveLength(7);
    expect(d.body.collection[6]).toEqual({ period: '2026-11-15', totalPoisha: 220000, cashPoisha: 170000, mobilePoisha: 50000, count: 3, visits: 1 });
    expect(d.body.collection[0]).toMatchObject({ period: '2026-11-09', totalPoisha: 0, count: 0 });
    expect(d.body.overdue.map((o: { date: string }) => o.date)).toEqual(['2026-11-15']);
    const live = d.body.overdue[0];
    const inBuckets = ['d1_30', 'd31_60', 'd61_90', 'd90p'].reduce((n, k) => n + live.buckets[k].count, 0);
    expect(inBuckets).toBe(live.totalOverdue.count);
    expect(live.totalOverdue.count).toBeGreaterThan(0);

    expect(await snapshotOverdue('2026-11-14')).toBe(2);
    expect(await snapshotOverdue('2026-11-14')).toBe(2); // re-run replaces
    const w = await bm.get('/reports/branch-trends?from=2026-11-09&to=2026-11-15&granularity=week');
    expectConforms('GET', '/reports/branch-trends', 200, w.body);
    expect(w.body.collection.map((c: { period: string; totalPoisha: number }) => [c.period, c.totalPoisha])).toEqual([['2026-11-07', 0], ['2026-11-14', 220000]]);
    expect(w.body.overdue.map((o: { date: string }) => o.date)).toEqual(['2026-11-14', '2026-11-15']);
    expect(w.body.overdue[0].totalOverdue).toEqual(live.totalOverdue); // one branch in scope, nothing changed since
    const mo = await bm.get('/reports/branch-trends?from=2026-10-20&to=2026-11-14&granularity=month');
    expect(mo.body.collection.map((c: { period: string }) => c.period)).toEqual(['2026-10', '2026-11']);
    expect(mo.body.overdue).toHaveLength(1); // range ends yesterday: snapshot only, no live entry
  });

  it('scope and validation', async () => {
    const bm = await as(t, BM);
    expect((await bm.get('/reports/branch-trends?from=2025-01-01&to=2026-11-15')).status).toBe(400);
    expect((await bm.get('/reports/branch-trends?from=2026-11-10&to=2026-11-16')).status).toBe(400);
    expect((await bm.get('/reports/branch-trends?from=2026-11-10&to=2026-11-15&granularity=year')).status).toBe(400);
    expect((await bm.get(`/reports/branch-trends?from=2026-11-10&to=2026-11-15&branchId=${s.branchB}`)).status).toBe(404);
    expect((await (await as(t, FS1)).get('/reports/branch-trends?from=2026-11-10&to=2026-11-15')).status).toBe(403);
    // Other branch: no collections there, and its snapshot is not mixed into branch A's numbers.
    const sa = await as(t, '01700000001');
    const b = await sa.get(`/reports/branch-trends?from=2026-11-14&to=2026-11-15&branchId=${s.branchB}`);
    expect(b.body.collection.every((c: { totalPoisha: number }) => c.totalPoisha === 0)).toBe(true);
  });
});

describe('reconciliation (FR-COL-014)', () => {
  it('matches posted collections with ERP field payments and lists what is still waiting', async () => {
    const bm = await as(t, BM);
    const r = await bm.get('/reports/reconciliation?date=2026-11-15');
    expect(r.status).toBe(200);
    expectConforms('GET', '/reports/reconciliation', 200, r.body);
    expect(r.body.totals).toEqual({ fosPostedCount: 2, fosPostedPoisha: 200000, fosWaitingCount: 1, fosWaitingPoisha: 20000, erpCount: 2, erpPoisha: 200000, matchedCount: 2 });
    expect(r.body.balanced).toBe(false);
    expect(r.body.erpFetchedAt).toMatch(/^2026-11-15T/);
    expect(r.body.mismatches).toHaveLength(1);
    expect(r.body.mismatches[0]).toMatchObject({ kind: 'not_posted', receiptNo: 'BRL01-FS014-261115-0003', fosAmountPoisha: 20000, status: 'received', collector: { id: s.fs1.id } });
    expect(r.body.mismatches[0].customer.id).toBe(ids['100246']);

    const quiet = await bm.get('/reports/reconciliation?date=2026-11-14');
    expect(quiet.body).toMatchObject({ balanced: true, erpFetchedAt: null, mismatches: [] });
    expect((await bm.get('/reports/reconciliation?date=2026-11-16')).status).toBe(400);
    expect((await bm.get('/reports/reconciliation')).status).toBe(400);
    expect((await bm.get(`/reports/reconciliation?date=2026-11-15&branchId=${s.branchB}`)).status).toBe(404);
    expect((await (await as(t, FS1)).get('/reports/reconciliation?date=2026-11-15')).status).toBe(403);
  });

  it('is balanced once the worker has posted everything', async () => {
    await dispatchOutbox();
    const r = await (await as(t, BM)).get('/reports/reconciliation?date=2026-11-15');
    expect(r.body).toMatchObject({ balanced: true, mismatches: [] });
    expect(r.body.totals).toMatchObject({ fosPostedCount: 3, fosPostedPoisha: 220000, erpPoisha: 220000, matchedCount: 3 });
  });
});

describe('exports (FR-REP-003/004)', () => {
  const mem = () => storage() as MemoryStorage;
  const text = (key: string) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(mem().objects.get(key)!.body);

  it('queues, builds in the worker, and gives only the requester a short-lived link', async () => {
    const bm = await as(t, BM);
    const r = await bm.post('/reports/exports', { type: 'collections', format: 'csv', params: { from: '2026-11-01', to: '2026-11-15' }, locale: 'bn' });
    expect(r.status).toBe(202);
    expectConforms('POST', '/reports/exports', 202, r.body);
    expect(r.body.status).toBe('queued');
    const queued = await bm.get(`/reports/exports/${r.body.id}`);
    expectConforms('GET', '/reports/exports/{id}', 200, queued.body);
    expect(queued.body).toEqual({ id: r.body.id, status: 'queued' });
    expect(await AuditLogModel.countDocuments({ action: 'report.export.requested', entityId: r.body.id })).toBe(1);

    expect(await processExports()).toBe(1);
    const ready = await bm.get(`/reports/exports/${r.body.id}`);
    expectConforms('GET', '/reports/exports/{id}', 200, ready.body);
    expect(ready.body.status).toBe('ready');
    expect(ready.body.downloadUrl).toContain('exports');
    const doc = await ExportModel.findById(r.body.id).lean();
    expect(doc!.rows).toBe(3);
    const csv = text(doc!.storageKey!);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).trim().split('\r\n');
    expect(lines[0]).toContain('রশিদ নং');
    expect(lines[1]).toMatch(/^BRL01-FS014-261115-0001,2026-11-15,09:31,BRL01,/); // Dhaka time
    expect(lines[1]).toContain(',1500,cash,posted,R-');
    expect(lines).toHaveLength(4);

    const sa = await as(t, '01700000001');
    expect((await sa.get(`/reports/exports/${r.body.id}`)).status).toBe(404); // someone else's export
    expect((await bm.get('/reports/exports/not-an-id')).status).toBe(404);
  });

  it('every dataset builds, in CSV and XLSX, within the requester scope', async () => {
    const bm = await as(t, BM);
    const ask = async (body: Record<string, unknown>) => (await bm.post('/reports/exports', body)).body.id as string;
    const perf = await ask({ type: 'staff_performance', format: 'xlsx', params: { period: 'monthly', date: '2026-11' }, locale: 'en' });
    const att = await ask({ type: 'attendance', format: 'csv', params: { from: '2026-11-14', to: '2026-11-15' }, locale: 'en' });
    const over = await ask({ type: 'overdue_customers', format: 'csv', params: {} });
    const cash = await ask({ type: 'cash_positions', format: 'csv', params: { branchId: s.branchA }, locale: 'en' });
    expect(await processExports()).toBe(4);
    const docs = new Map((await ExportModel.find({ _id: { $in: [perf, att, over, cash] } }).lean()).map((d) => [d._id.toHexString(), d]));
    for (const id of [perf, att, over, cash]) expect([docs.get(id)!.status, docs.get(id)!.error]).toEqual(['ready', null]);

    const x = mem().objects.get(docs.get(perf)!.storageKey!)!;
    expect(Buffer.from(x.body).subarray(0, 2).toString()).toBe('PK');
    expect(x.contentType).toContain('spreadsheetml');
    const a = text(docs.get(att)!.storageKey!).slice(1).trim().split('\r\n');
    expect(a[0]).toBe('Staff,Code,Date,Status,First in,Last out,Late (min),Break (min),Duty (min),Flags');
    expect(a).toHaveLength(1 + 2 * 2); // two staff × two days, own branch only
    expect(a.some((l) => l.startsWith('Rakib Hasan,FS014,2026-11-15,on_duty,09:00,'))).toBe(true);
    const o = text(docs.get(over)!.storageKey!);
    expect(o).toContain('ERP থেকে আনা হয়েছে'); // cached ERP figures carry their age
    expect(docs.get(over)!.rows).toBeGreaterThan(0);
    const c = text(docs.get(cash)!.storageKey!).slice(1).trim().split('\r\n');
    expect(c.find((l) => l.startsWith('Rakib Hasan,'))).toMatch(/^Rakib Hasan,1700,/); // cash on hand in taka
  });

  it('refuses what is not built, bad params, other branches and missing permission', async () => {
    const bm = await as(t, BM);
    const pdf = await bm.post('/reports/exports', { type: 'collections', format: 'pdf', params: { from: '2026-11-01', to: '2026-11-15' } });
    expect(pdf.status).toBe(422);
    expect(pdf.body.details ?? pdf.body).toMatchObject({ rule: 'export_format_unavailable' });
    expect((await bm.post('/reports/exports', { type: 'audit', format: 'csv' })).status).toBe(422);
    expect((await bm.post('/reports/exports', { type: 'collections', format: 'csv', params: { from: '2026-01-01', to: '2026-11-15' } })).status).toBe(400);
    expect((await bm.post('/reports/exports', { type: 'collections', format: 'csv', params: {} })).status).toBe(400);
    expect((await bm.post('/reports/exports', { type: 'payroll', format: 'csv' })).status).toBe(400);
    expect((await bm.post('/reports/exports', { type: 'cash_positions', format: 'csv', params: { branchId: s.branchB } })).status).toBe(404);
    expect((await (await as(t, FS1)).post('/reports/exports', { type: 'cash_positions', format: 'csv' })).status).toBe(403);
    expect((await (await as(t, '01700000006')).post('/reports/exports', { type: 'cash_positions', format: 'csv' })).status).toBe(403); // viewer reads, does not export
    expect(await ExportModel.countDocuments({ status: 'queued' })).toBe(0); // nothing refused was stored
    expect(await processExports()).toBe(0);
  });

  it('an export is gone after 7 days', async () => {
    const bm = await as(t, BM);
    const id = (await bm.post('/reports/exports', { type: 'cash_positions', format: 'csv' })).body.id as string;
    await processExports();
    t.clock.advance(8 * 86_400_000);
    const later = await as(t, BM);
    expect((await later.get(`/reports/exports/${id}`)).status).toBe(404);
  });
});
