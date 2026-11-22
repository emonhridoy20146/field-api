import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, createTestApp, handIn, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { deltaSync, syncBranches } from '../../src/modules/erp-gateway/index.js';
import { applyAssignments, getByErpId } from '../../src/modules/customers/index.js';
import { dispatchOutbox } from '../../src/core/events/outbox.js';
import { storage, type MemoryStorage } from '../../src/core/storage/index.js';
import { setSystem } from '../../src/modules/settings/index.js';
import { setFlagSystem } from '../../src/modules/flags/index.js';
import { processExports } from '../../src/modules/reports/exports.js';
import { ExportModel } from '../../src/modules/reports/models/report.model.js';
import { AuditLogModel } from '../../src/modules/audit/models/audit-log.model.js';

// FR-COL-015 daily targets, FR-REP-005 leaderboard and own performance, FR-CUS-009 data quality, OD-26 PDF.
let t: TestApp;
let s: Seeded;
const ids: Record<string, string> = {};
const geo = { lat: 22.7106, lng: 90.3703, accuracyM: 9 };
const SA = '01700000001';
const BM = '01700000002';
const FS1 = '01700000003';
const FS2 = '01700000004';
const FSB = '01700000005';
const VW = '01700000006';
const collect = (c: Awaited<ReturnType<typeof as>>, n: number, amountPoisha: number, method: string, extra: Record<string, unknown> = {}) =>
  c.post('/collections', { clientId: randomUUID(), customerId: ids['100246'], amountPoisha, method, recordedAt: `2026-11-15T03:3${n}:00Z`, receiptNo: `BRL01-FS014-261115-000${n}`, geo, ...extra }, { 'idempotency-key': randomUUID() });

beforeAll(async () => {
  t = await createTestApp(); // Sunday 2026-11-15 10:00 Dhaka; Friday is the default weekly off
  t.erp.allowSameDay = true; // several collections on one invoice today (OD-27 granted in this scenario)
  s = await seedBasics(t);
  await deltaSync();
  for (const e of ['100245', '100246', '100247', '100248']) ids[e] = (await getByErpId(e))!.id;
  await applyAssignments([
    { customerId: ids['100245']!, assigneeId: s.fs1.id },
    { customerId: ids['100246']!, assigneeId: s.fs1.id },
  ]);
  const fs = await as(t, FS1);
  await fs.post('/attendance/events', { clientId: randomUUID(), type: 'work_in', at: '2026-11-15T03:00:00Z', geo });
  await fs.post('/visits', { clientId: randomUUID(), customerId: ids['100245'], checkInAt: '2026-11-15T03:30:00Z', outcome: 'partial_paid', geo });
  expect((await collect(fs, 1, 150000, 'cash')).status).toBe(201);
  expect((await collect(fs, 2, 50000, 'bkash', { transactionRef: 'BKX1234567' })).status).toBe(201);
  await handIn(fs); // 1.35.0: a collection goes to the ERP once deposited
  await dispatchOutbox(); // both posted to the mock ERP
  expect((await collect(fs, 3, 20000, 'cash')).status).toBe(201); // still in hand, not deposited
});
afterAll(async () => t.close());

describe('daily targets (FR-COL-015)', () => {
  it('starts at zero, takes a branch default and a personal target, and shows where each comes from', async () => {
    const bm = await as(t, BM);
    const empty = await bm.get('/targets');
    expect(empty.status).toBe(200);
    expectConforms('GET', '/targets', 200, empty.body);
    expect(empty.body).toMatchObject({ branchId: s.branchA, date: '2026-11-15', defaults: { amountPoisha: 0, visits: 0, effectiveFrom: null, setBy: null } });
    expect(empty.body.items.map((i: { userId: string }) => i.userId)).toEqual([s.fs1.id, s.fs2.id]);
    expect(empty.body.items[0]).toMatchObject({ amountPoisha: 0, visits: 0, source: 'branch', workingDay: true });

    const b = await bm.put(`/targets/branches/${s.branchA}`, { amountPoisha: 300000, visits: 4, reason: 'November plan' });
    expect(b.status).toBe(200);
    expectConforms('PUT', '/targets/branches/{id}', 200, b.body);
    expect(b.body).toMatchObject({ amountPoisha: 300000, visits: 4, effectiveFrom: '2026-11-15', reason: 'November plan', setBy: { id: s.bm.id, name: 'Manager A' } });

    const p = await bm.put(`/targets/users/${s.fs1.id}`, { amountPoisha: 200000, visits: 2.5, reason: 'Smaller area' });
    expect(p.status).toBe(200);
    expectConforms('PUT', '/targets/users/{id}', 200, p.body);
    expect(p.body).toMatchObject({ userId: s.fs1.id, name: 'Rakib Hasan', employeeCode: 'FS014', amountPoisha: 200000, visits: 2.5, source: 'personal', workingDay: true, effectiveFrom: '2026-11-15' });

    const l = await bm.get('/targets');
    expectConforms('GET', '/targets', 200, l.body);
    expect(l.body.defaults).toMatchObject({ amountPoisha: 300000, visits: 4 });
    expect(l.body.items.map((i: { amountPoisha: number; source: string }) => [i.amountPoisha, i.source])).toEqual([
      [200000, 'personal'],
      [300000, 'branch'],
    ]);
    // Friday is the weekly off: no target that day.
    const fri = await bm.get('/targets?date=2026-11-20');
    expect(fri.body.items.map((i: { amountPoisha: number; workingDay: boolean }) => [i.amountPoisha, i.workingDay])).toEqual([
      [0, false],
      [0, false],
    ]);
    expect((await (await as(t, VW)).get('/targets')).status).toBe(200); // viewers read
  });

  it('clearing from a later date falls back to the branch default; history keeps every change', async () => {
    const bm = await as(t, BM);
    const c = await bm.post(`/targets/users/${s.fs1.id}/clear`, { effectiveFrom: '2026-11-16', reason: 'Area merged back' });
    expect(c.status).toBe(200);
    expectConforms('POST', '/targets/users/{id}/clear', 200, c.body);
    expect(c.body).toMatchObject({ amountPoisha: 300000, visits: 4, source: 'branch' });
    expect((await bm.get('/targets')).body.items[0]).toMatchObject({ amountPoisha: 200000, source: 'personal' }); // today unchanged
    expect((await bm.get('/targets?date=2026-11-16')).body.items[0]).toMatchObject({ amountPoisha: 300000, source: 'branch' });

    const h = await bm.get(`/targets/users/${s.fs1.id}/history`);
    expect(h.status).toBe(200);
    expectConforms('GET', '/targets/users/{id}/history', 200, h.body);
    expect(h.body.map((r: { kind: string; effectiveFrom: string }) => [r.kind, r.effectiveFrom])).toEqual([
      ['cleared', '2026-11-16'],
      ['set', '2026-11-15'],
    ]);
    expect(h.body[0]).toMatchObject({ amountPoisha: null, visits: null, reason: 'Area merged back', setBy: { id: s.bm.id } });
    expect(await AuditLogModel.countDocuments({ action: { $in: ['target.set', 'target.cleared', 'target.branch_set'] }, entity: 'target' })).toBe(3);
  });

  it('refuses past dates, bad input, other branches and staff', async () => {
    const bm = await as(t, BM);
    const past = await bm.put(`/targets/users/${s.fs1.id}`, { amountPoisha: 1, visits: 1, effectiveFrom: '2026-11-14', reason: 'Backdated' });
    expect(past.status).toBe(422);
    expect(past.body.details.rule).toBe('TARGET_IN_PAST');
    expect((await bm.put(`/targets/users/${s.fs1.id}`, { amountPoisha: 1, visits: 1, reason: 'no' })).status).toBe(400);
    expect((await bm.put(`/targets/users/${s.fs1.id}`, { amountPoisha: -1, visits: 1, reason: 'Negative' })).status).toBe(400);
    expect((await bm.put(`/targets/users/${s.fs1.id}`, { amountPoisha: 1, visits: 101, reason: 'Too many' })).status).toBe(400);
    expect((await bm.put(`/targets/users/${s.fs1.id}`, { amountPoisha: 1, visits: 1, effectiveFrom: '15-11-2026', reason: 'Bad date' })).status).toBe(400);
    expect((await bm.put(`/targets/users/${s.fsB.id}`, { amountPoisha: 1, visits: 1, reason: 'Other branch' })).status).toBe(404);
    expect((await bm.put(`/targets/users/${s.bm.id}`, { amountPoisha: 1, visits: 1, reason: 'Not field staff' })).status).toBe(404);
    expect((await bm.put('/targets/users/not-an-id', { amountPoisha: 1, visits: 1, reason: 'Bad id' })).status).toBe(404);
    expect((await bm.put(`/targets/branches/${s.branchB}`, { amountPoisha: 1, visits: 1, reason: 'Other branch' })).status).toBe(404);
    expect((await bm.get(`/targets?branchId=${s.branchB}`)).status).toBe(404);
    expect((await bm.get(`/targets/users/${s.fsB.id}/history`)).status).toBe(404);
    const fs = await as(t, FS1);
    expect((await fs.get('/targets')).status).toBe(403);
    expect((await fs.put(`/targets/users/${s.fs1.id}`, { amountPoisha: 1, visits: 1, reason: 'Own target' })).status).toBe(403);
    expect((await (await as(t, VW)).put(`/targets/branches/${s.branchA}`, { amountPoisha: 1, visits: 1, reason: 'Viewer' })).status).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/targets' })).statusCode).toBe(401);
    const sa = await as(t, SA);
    expect((await sa.get(`/targets?branchId=${s.branchB}`)).body.items.map((i: { userId: string }) => i.userId)).toEqual([s.fsB.id]);
  });

  it('staff see their own target in /targets/me and in the sync envelope', async () => {
    const fs = await as(t, FS1);
    const me = await fs.get('/targets/me');
    expect(me.status).toBe(200);
    expectConforms('GET', '/targets/me', 200, me.body);
    expect(me.body).toEqual({ businessDate: '2026-11-15', amountPoisha: 200000, visits: 2.5, source: 'personal', workingDay: true });
    expect((await fs.get('/targets/me?date=2026-11-16')).body).toMatchObject({ amountPoisha: 300000, source: 'branch' });
    expect((await fs.get('/targets/me?date=2026-11-20')).body).toMatchObject({ amountPoisha: 0, workingDay: false });
    expect((await fs.get('/targets/me?date=yesterday')).status).toBe(400);
    const boot = await fs.get('/sync/bootstrap?limit=1');
    expectConforms('GET', '/sync/bootstrap', 200, boot.body);
    expect(boot.body.target).toEqual(me.body);
    // The envelope leaves the target out while the module is off.
    await setFlagSystem('module.targets', false);
    expect((await (await as(t, FS1)).get('/sync/bootstrap?limit=1')).body.target).toBeUndefined();
    await setFlagSystem('module.targets', true);
  });
});

describe('targets in reports (FR-COL-015, FR-REP-001)', () => {
  it('staff performance compares collections and visits with the target to date', async () => {
    const bm = await as(t, BM);
    const d = await bm.get('/reports/staff-performance?period=daily&date=2026-11-15');
    expectConforms('GET', '/reports/staff-performance', 200, d.body);
    expect(d.body[0]).toMatchObject({ userId: s.fs1.id, targetPoisha: 200000, visitTarget: 2.5, targetToDatePoisha: 200000, amountAchievement: 1.1, visitAchievement: 0.4, targetDays: 1 });
    expect(d.body[1]).toMatchObject({ userId: s.fs2.id, targetPoisha: 300000, visitTarget: 4, amountAchievement: 0, visitAchievement: 0 });

    // The month: 15th personal, 16th..30th branch default on 13 working days (20th and 27th are Fridays).
    const m = await bm.get(`/reports/staff-performance?period=monthly&date=2026-11&userId=${s.fs1.id}`);
    expectConforms('GET', '/reports/staff-performance', 200, m.body);
    expect(m.body[0]).toMatchObject({ targetPoisha: 200000 + 13 * 300000, visitTarget: 2.5 + 13 * 4, targetToDatePoisha: 200000, visitTargetToDate: 2.5, amountAchievement: 1.1, targetDays: 14 });
    // Before any target there is nothing to measure against.
    expect((await bm.get('/reports/staff-performance?period=daily&date=2026-11-14')).body[0]).toMatchObject({ targetPoisha: 0, amountAchievement: null, visitAchievement: null });
  });

  it('the dashboard shows the team target and visit credit for the day', async () => {
    const r = await (await as(t, BM)).get('/dashboard/overview');
    expect(r.status).toBe(200);
    expectConforms('GET', '/dashboard/overview', 200, r.body);
    expect(r.body.collected.targetPoisha).toBe(500000);
    expect(r.body.visits).toMatchObject({ credit: 1, target: 6.5 });
  });
});

describe('leaderboard (FR-REP-005)', () => {
  it('ranks staff for managers; staff without attendance are listed but not ranked', async () => {
    const bm = await as(t, BM);
    const r = await bm.get('/reports/leaderboard?period=day');
    expect(r.status).toBe(200);
    expectConforms('GET', '/reports/leaderboard', 200, r.body);
    expect(r.body).toMatchObject({ branchId: null, period: 'day', date: '2026-11-15', metric: 'collected', minPresentDays: 1, me: null }); // every branch in scope
    expect(r.body.items.map((i: { userId: string; rank: number | null; value: number; eligible: boolean }) => [i.userId, i.rank, i.value, i.eligible])).toEqual([
      [s.fs1.id, 1, 220000, true],
      [s.fs2.id, null, 0, false],
    ]);
    expect(r.body.items[0]).toMatchObject({ employeeCode: 'FS014', name: 'Rakib Hasan' });

    const fs2 = await as(t, FS2);
    await fs2.post('/attendance/events', { clientId: randomUUID(), type: 'work_in', at: '2026-11-15T03:05:00Z', geo });
    const after = await bm.get('/reports/leaderboard?period=day&metric=target_achievement');
    expectConforms('GET', '/reports/leaderboard', 200, after.body);
    expect(after.body.items.map((i: { rank: number | null; value: number | null }) => [i.rank, i.value])).toEqual([
      [1, 1.1],
      [2, 0],
    ]);
    const v = await bm.get('/reports/leaderboard?period=month&date=2026-11&metric=visit_credit');
    expect(v.body.items.map((i: { rank: number | null; value: number }) => [i.rank, i.value])).toEqual([
      [1, 1],
      [2, 0],
    ]);
    const k = await bm.get('/reports/leaderboard?period=month&metric=promises_kept');
    expect(k.body.items.map((i: { rank: number | null }) => i.rank)).toEqual([1, 1]); // both 0: a tie shares the rank
    expect((await (await as(t, VW)).get('/reports/leaderboard?period=day')).status).toBe(200);
    expect((await (await as(t, SA)).get(`/reports/leaderboard?period=day&branchId=${s.branchB}`)).body.items.map((i: { userId: string }) => i.userId)).toEqual([s.fsB.id]);
  });

  it('field staff see it only when the branch turns it on, and only their own branch', async () => {
    const fs = await as(t, FS1);
    expect((await fs.get('/reports/leaderboard?period=day')).status).toBe(403);
    await setSystem('reports.leaderboardVisibleToStaff', true, s.branchA);
    const r = await fs.get('/reports/leaderboard?period=day');
    expect(r.status).toBe(200);
    expectConforms('GET', '/reports/leaderboard', 200, r.body);
    expect(r.body.me).toEqual({ rank: 1, of: 2 });
    expect(r.body.items.map((i: { me: boolean }) => i.me)).toEqual([true, false]);
    expect(r.body.items[1].value).toBe(0); // a colleague's figures, though their own scope only covers their own work
    expect((await fs.get(`/reports/leaderboard?period=day&branchId=${s.branchB}`)).status).toBe(404);
    expect((await (await as(t, FSB)).get('/reports/leaderboard?period=day')).status).toBe(403); // still off in branch B
  });

  it('validation and scope', async () => {
    const bm = await as(t, BM);
    expect((await bm.get('/reports/leaderboard?period=week')).status).toBe(400);
    expect((await bm.get('/reports/leaderboard?period=day&date=2026-11-16')).status).toBe(400);
    expect((await bm.get('/reports/leaderboard?period=month&date=2026-12')).status).toBe(400);
    expect((await bm.get('/reports/leaderboard?period=day&metric=distance')).status).toBe(400);
    expect((await bm.get(`/reports/leaderboard?period=day&branchId=${s.branchB}`)).status).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/reports/leaderboard?period=day' })).statusCode).toBe(401);
  });
});

describe('own performance (FR-REP-005)', () => {
  it('gives staff their month, day by day, with posted and pending money and their rank', async () => {
    const fs = await as(t, FS1);
    const r = await fs.get('/reports/me/performance?month=2026-11');
    expect(r.status).toBe(200);
    expectConforms('GET', '/reports/me/performance', 200, r.body);
    expect(r.body).toMatchObject({ month: '2026-11', collectedTotalPoisha: 220000, postedPoisha: 200000, pendingPoisha: 20000, rank: { metric: 'collected', rank: 1, of: 2 } });
    expect(r.body.row).toMatchObject({ userId: s.fs1.id, collectionsCount: 3, visits: 1, targetToDatePoisha: 200000 });
    expect(r.body.days).toHaveLength(15); // 1st to today
    expect(r.body.days[14]).toEqual({ date: '2026-11-15', collectedPoisha: 220000, collectionsCount: 3, visits: 1, soloVisits: 1, coWorkVisits: 0, visitCredit: 1, targetPoisha: 200000, visitTarget: 2.5, workingDay: true });
    expect(r.body.days[12]).toMatchObject({ date: '2026-11-13', workingDay: false, targetPoisha: 0 }); // Friday

    await setSystem('reports.leaderboardVisibleToStaff', false, s.branchA);
    expect((await fs.get('/reports/me/performance?month=2026-11')).body.rank).toBeNull();
    expect((await fs.get('/reports/me/performance?month=2026-12')).status).toBe(400);
    expect((await fs.get('/reports/me/performance')).status).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/reports/me/performance?month=2026-11' })).statusCode).toBe(401);
    const other = await (await as(t, FS2)).get('/reports/me/performance?month=2026-11');
    expect(other.body).toMatchObject({ collectedTotalPoisha: 0, row: { userId: s.fs2.id } }); // never someone else's figures
  });
});

describe('data quality (FR-CUS-009)', () => {
  it('counts issues per branch and lists the customers behind each', async () => {
    const bm = await as(t, BM);
    const r = await bm.get('/reports/data-quality');
    expect(r.status).toBe(200);
    expectConforms('GET', '/reports/data-quality', 200, r.body);
    expect(r.body.maxBranchKm).toBe(30);
    expect(r.body.branches).toHaveLength(1);
    const a = r.body.branches[0];
    expect(a).toMatchObject({ branchId: s.branchA, maxBranchKm: 30, customers: 4, withIssues: 3 });
    // 100247 has no coordinates and 100248 has 0,0, which the ERP mapper already treats as none.
    expect(a.issues).toMatchObject({ no_location: 2, invalid_location: 0, suspect_swapped: 1, unassigned: 2, missing_phone: 0, invalid_phone: 0, shared_phone: 0, far_from_branch: 0 });

    const none = await bm.get('/reports/data-quality/items?issue=no_location');
    expectConforms('GET', '/reports/data-quality/items', 200, none.body);
    expect(none.body.items.map((i: { code: string }) => i.code).sort()).toEqual(['BRL01-100247', 'BRL01-100248']);
    expect(none.body.items.find((i: { code: string }) => i.code === 'BRL01-100247')).toMatchObject({ issue: 'no_location', assignee: null, issues: ['no_location', 'unassigned'] });
    const swapped = await bm.get('/reports/data-quality/items?issue=suspect_swapped');
    expect(swapped.body.items[0]).toMatchObject({ code: 'BRL01-100246', assignee: { id: s.fs1.id, name: 'Rakib Hasan' } });
    expect(swapped.body.items[0].detail).toContain('swapped');

    const p1 = await bm.get('/reports/data-quality/items?issue=unassigned&limit=1');
    expect(p1.body.items).toHaveLength(1);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await bm.get(`/reports/data-quality/items?issue=unassigned&limit=1&cursor=${encodeURIComponent(p1.body.nextCursor)}`);
    expect(p2.body.nextCursor).toBeNull();
    expect(new Set([p1.body.items[0].code, p2.body.items[0].code])).toEqual(new Set(['BRL01-100247', 'BRL01-100248']));

    // The ERP has no branch coordinates (1.13.0): without a FOS branch point nothing can be "far".
    await setSystem('reports.dataQualityMaxBranchKm', 0.001, s.branchA);
    expect((await bm.get('/reports/data-quality')).body.branches[0].issues.far_from_branch).toBe(0);
    const sa = await as(t, SA);
    expect((await bm.put(`/branches/${s.branchA}/location`, { lat: 22.701002, lng: 90.353451 })).status).toBe(403);
    expect((await sa.put(`/branches/${s.branchA}/location`, { lat: 51.5, lng: -0.12 })).status).toBe(422);
    const set = await sa.put(`/branches/${s.branchA}/location`, { lat: 22.701002, lng: 90.353451 });
    expect(set.status).toBe(200);
    expectConforms('PUT', '/branches/{id}/location', 200, set.body);
    expect(set.body).toMatchObject({ lat: 22.701002, lng: 90.353451 });
    // ERP sync keeps a FOS branch point and the location kind (warehouses hold receivables too).
    await syncBranches();
    const locs = await sa.get('/branches');
    expectConforms('GET', '/branches', 200, locs.body);
    expect(locs.body.find((b: { id: string }) => b.id === s.branchA)).toMatchObject({ kind: 'branch', lat: 22.701002, lng: 90.353451 });
    expect(locs.body.find((b: { code: string }) => b.code === 'W')).toMatchObject({ kind: 'warehouse', lat: null });
    // A tighter radius from settings makes every located customer "far".
    await setSystem('reports.dataQualityMaxBranchKm', 0.001, s.branchA);
    const near = await bm.get('/reports/data-quality');
    expect(near.body.branches[0]).toMatchObject({ maxBranchKm: 0.001, issues: { far_from_branch: 1 } });
    expect(near.body.maxBranchKm).toBe(30); // the system default stays
    await setSystem('reports.dataQualityMaxBranchKm', 30, s.branchA);

    const all = await (await as(t, SA)).get('/reports/data-quality');
    expect(all.body.branches.map((b: { branchId: string }) => b.branchId)).toEqual([s.branchA, s.branchB]);
  });

  it('validation, permission and scope', async () => {
    const bm = await as(t, BM);
    expect((await bm.get('/reports/data-quality/items')).status).toBe(400);
    expect((await bm.get('/reports/data-quality/items?issue=bad_name')).status).toBe(400);
    expect((await bm.get('/reports/data-quality/items?issue=unassigned&limit=500')).status).toBe(400);
    expect((await bm.get(`/reports/data-quality?branchId=${s.branchB}`)).status).toBe(404);
    expect((await (await as(t, FS1)).get('/reports/data-quality')).status).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/reports/data-quality' })).statusCode).toBe(401);
  });
});

describe('exports: data quality and PDF (FR-REP-003, OD-26)', () => {
  const mem = () => storage() as MemoryStorage;

  it('data quality exports one line per customer and issue', async () => {
    const bm = await as(t, BM);
    const all = (await bm.post('/reports/exports', { type: 'data_quality', format: 'csv', params: {}, locale: 'en' })).body.id as string;
    const one = (await bm.post('/reports/exports', { type: 'data_quality', format: 'csv', params: { issue: 'unassigned' }, locale: 'bn' })).body.id as string;
    expect(await processExports()).toBe(2);
    const docs = new Map((await ExportModel.find({ _id: { $in: [all, one] } }).lean()).map((d) => [d._id.toHexString(), d]));
    const text = (id: string) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(mem().objects.get(docs.get(id)!.storageKey!)!.body).slice(1).trim().split('\r\n');
    const a = text(all);
    expect(a[0]).toBe('Issue,Customer code,Customer,Branch,Area,Assigned to,Detail');
    expect(a).toHaveLength(1 + 5); // two without location, one swapped, two unassigned
    expect(a).toContain('no location,BRL01-100247,Shahidul Islam,BRL01,BSL-CHK,,No coordinates');
    expect(a.filter((l) => l.startsWith('unassigned,'))).toHaveLength(2);
    const b = text(one);
    expect(b).toHaveLength(1 + 2);
    expect(b.slice(1).every((l) => l.startsWith('কর্মী নির্ধারিত নেই,BRL01-10024'))).toBe(true);
    expect((await bm.post('/reports/exports', { type: 'data_quality', format: 'csv', params: { branchId: s.branchB } })).status).toBe(404);
    expect((await bm.post('/reports/exports', { type: 'data_quality', format: 'csv', params: { issue: 'bad_name' } })).status).toBe(400);
  });

  it('builds a PDF with embedded Bangla fonts', async () => {
    const bm = await as(t, BM);
    const id = (await bm.post('/reports/exports', { type: 'staff_performance', format: 'pdf', params: { period: 'daily', date: '2026-11-15' }, locale: 'bn' })).body.id as string;
    expect(await processExports()).toBe(1);
    const doc = await ExportModel.findById(id).lean();
    expect([doc!.status, doc!.error, doc!.rows]).toEqual(['ready', null, 2]);
    expect(doc!.storageKey).toMatch(/\.pdf$/);
    const o = mem().objects.get(doc!.storageKey!)!;
    expect(o.contentType).toBe('application/pdf');
    const raw = Buffer.from(o.body).toString('latin1');
    expect(raw.startsWith('%PDF-1.')).toBe(true);
    expect(raw.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(raw).toContain('/FontFile2');
    expect(raw).toContain('/MediaBox [0 0 841.89 595.28]');
    const ready = await bm.get(`/reports/exports/${id}`);
    expectConforms('GET', '/reports/exports/{id}', 200, ready.body);
    expect(ready.body.status).toBe('ready');
  });
});

describe('collection board (FR-REP-007, ADR-045)', () => {
  it('ranks everyone by money the ERP has accepted, across branches, for a month and for all time; pending money is not counted', async () => {
    const bm = await as(t, BM);
    const fs = await as(t, FS1);
    await handIn(fs);
    await dispatchOutbox(); // whatever was still waiting is posted now: FS014 has 150000 + 50000 + 20000
    // one more collection that the ERP does not have yet
    expect((await collect(fs, 5, 70000, 'cash')).status).toBe(201);

    const r = await bm.get('/reports/collection-board?period=month');
    expect(r.status).toBe(200);
    expectConforms('GET', '/reports/collection-board', 200, r.body);
    expect(r.body).toMatchObject({ period: 'month', month: '2026-11', scope: 'all', branchId: null, me: null });
    // every branch: FSB of branch B is listed for a branch A manager; people with nothing posted follow unranked, by name
    expect(r.body.items.map((i: { userId: string; rank: number | null; postedPoisha: number; count: number }) => [i.userId, i.rank, i.postedPoisha, i.count])).toEqual([
      [s.fs1.id, 1, 220000, 3],
      [s.fsB.id, null, 0, 0],
      [s.fs2.id, null, 0, 0],
    ]);
    expect(r.body.items[0]).toMatchObject({ employeeCode: 'FS014', role: 'field_staff', branchId: s.branchA, me: false });
    expect(r.body.items[0].name.en).toBe('Rakib Hasan');

    // a manager who collects is on the board, by collections alone
    expect((await collect(bm, 6, 300000, 'cash', { receiptNo: 'BRL01-BM001-261115-0006' })).status).toBe(201);
    await handIn(bm);
    await handIn(fs);
    await dispatchOutbox(); // posts the manager's 300000 and the 70000 that was waiting
    const all = await bm.get('/reports/collection-board?period=all');
    expectConforms('GET', '/reports/collection-board', 200, all.body);
    expect(all.body).toMatchObject({ period: 'all', month: null, me: { rank: 1, of: 2, postedPoisha: 300000 } });
    expect(all.body.items.slice(0, 2).map((i: { userId: string; rank: number; postedPoisha: number; role: string; me: boolean }) => [i.userId, i.rank, i.postedPoisha, i.role, i.me])).toEqual([
      [s.bm.id, 1, 300000, 'branch_manager', true],
      [s.fs1.id, 2, 290000, 'field_staff', false],
    ]);
    // one branch only
    const b = await (await as(t, SA)).get(`/reports/collection-board?period=month&branchId=${s.branchB}`);
    expect(b.body.items.map((i: { userId: string }) => i.userId)).toEqual([s.fsB.id]);
    // an earlier month has nothing
    const oct = await bm.get('/reports/collection-board?period=month&month=2026-10');
    expect(oct.body.items.every((i: { rank: number | null }) => i.rank === null)).toBe(true);
  });

  it('field staff open it only when their branch turns the leaderboard on; the scope setting narrows it to the own branch', async () => {
    const fs = await as(t, FS1);
    expect((await fs.get('/reports/collection-board?period=month')).status).toBe(403);
    await setSystem('reports.leaderboardVisibleToStaff', true, s.branchA);
    const r = await fs.get('/reports/collection-board?period=month');
    expect(r.status).toBe(200);
    expectConforms('GET', '/reports/collection-board', 200, r.body);
    expect(r.body).toMatchObject({ scope: 'all', me: { rank: 2, of: 2, postedPoisha: 290000 } });
    expect(r.body.items.map((i: { userId: string }) => i.userId)).toContain(s.fsB.id); // every branch
    expect((await (await as(t, FSB)).get('/reports/collection-board?period=month')).status).toBe(403); // still off in branch B

    await setSystem('reports.leaderboardScope', 'branch');
    const own = await fs.get('/reports/collection-board?period=all');
    expect(own.body.scope).toBe('branch');
    expect(own.body.items.map((i: { userId: string }) => i.userId)).not.toContain(s.fsB.id);
    expect((await fs.get(`/reports/collection-board?period=all&branchId=${s.branchB}`)).status).toBe(404);
    expect((await (await as(t, BM)).get(`/reports/collection-board?period=all&branchId=${s.branchB}`)).status).toBe(404);
    expect((await (await as(t, SA)).get(`/reports/collection-board?period=all&branchId=${s.branchB}`)).status).toBe(200);
    await setSystem('reports.leaderboardScope', 'all');
    await setSystem('reports.leaderboardVisibleToStaff', false, s.branchA);
  });

  it('validation', async () => {
    const bm = await as(t, BM);
    expect((await bm.get('/reports/collection-board')).status).toBe(400);
    expect((await bm.get('/reports/collection-board?period=day')).status).toBe(400);
    expect((await bm.get('/reports/collection-board?period=month&month=2026-12')).status).toBe(400);
    expect((await bm.get('/reports/collection-board?period=all&month=2026-11')).status).toBe(400);
    expect((await bm.get('/reports/collection-board?period=all&branchId=nope')).status).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/reports/collection-board?period=month' })).statusCode).toBe(401);
  });
});
