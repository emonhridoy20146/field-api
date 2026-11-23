import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, client, createTestApp, handIn, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { mongoose } from '../../src/core/db/index.js';
import { dispatchOutbox } from '../../src/core/events/outbox.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { applyAssignments, getByErpId } from '../../src/modules/customers/index.js';

/**
 * FR-DSH-002 (contract 1.45.0): GET /dashboard/overview statistics with from/to and list links.
 * "Now" is Sunday 2026-11-15 10:00 Dhaka (04:00 UTC) unless a test moves the clock.
 */
let t: TestApp;
let s: Seeded;
const ids: Record<string, string> = {};
const geo = { lat: 22.7106, lng: 90.3703, accuracyM: 9 };
const BM = '01700000002';
const FS1 = '01700000003';
const FS2 = '01700000004';
const FSB = '01700000005';
const SA = '01700000001';
const NOW = '2026-11-15T04:00:00Z';

const collect = (c: Awaited<ReturnType<typeof as>>, customer: string, receiptNo: string, recordedAt: string, amountPoisha: number, method: string, extra: Record<string, unknown> = {}) =>
  c.post('/collections', { clientId: randomUUID(), customerId: ids[customer], amountPoisha, method, recordedAt, receiptNo, geo, ...extra }, { 'idempotency-key': randomUUID() });
const visit = (c: Awaited<ReturnType<typeof as>>, customer: string, checkInAt: string, outcome: string) => c.post('/visits', { clientId: randomUUID(), customerId: ids[customer], checkInAt, outcome, geo });

/** Promises are written straight to the store so their end state (and the 1.45.0 follow-up link) is exact. */
function promiseDoc(p: { customer: string; branchId: string; ownerId: string; promisedDate: string; amount: number; status: string; followUpId?: string | null }) {
  return {
    clientId: randomUUID(),
    branchId: p.branchId,
    customerId: ids[p.customer],
    erpPlanId: null,
    ownerId: p.ownerId,
    createdBy: p.ownerId,
    promisedDate: p.promisedDate,
    promisedAmountPoisha: p.amount,
    note: null,
    status: p.status,
    paidTowardsPoisha: 0,
    createdAt: new Date('2026-11-01T04:00:00Z'),
    createdDate: '2026-11-01',
    closedAt: null,
    closeReason: null,
    remindedFor: null,
    ...(p.followUpId !== undefined ? { followUpId: p.followUpId } : {}),
  };
}

beforeAll(async () => {
  t = await createTestApp({ now: '2026-10-20T04:00:00Z' });
  t.erp.allowSameDay = true;
  s = await seedBasics(t);
  await deltaSync();
  for (const e of ['100245', '100246', '100247', '100248', '200301']) ids[e] = (await getByErpId(e))!.id;
  await applyAssignments([
    { customerId: ids['100245']!, assigneeId: s.fs1.id },
    { customerId: ids['100246']!, assigneeId: s.fs1.id },
    { customerId: ids['100247']!, assigneeId: s.fs2.id },
    { customerId: ids['100248']!, assigneeId: s.fs2.id },
    { customerId: ids['200301']!, assigneeId: s.fsB.id },
  ]);

  // Previous month (October): one cash collection of fs1.
  const fsOct = await as(t, FS1);
  expect((await collect(fsOct, '100245', 'BRL01-FS014-261020-0001', '2026-10-20T03:40:00Z', 30000, 'cash')).status).toBe(201);

  t.clock.set(NOW);
  const fs1 = await as(t, FS1);
  const fs2 = await as(t, FS2);
  const fsB = await as(t, FSB);
  await fs1.post('/attendance/events', { clientId: randomUUID(), type: 'work_in', at: '2026-11-15T03:00:00Z', geo });
  expect((await collect(fs1, '100246', 'BRL01-FS014-261115-0001', '2026-11-15T03:31:00Z', 150000, 'cash')).status).toBe(201);
  expect((await collect(fs1, '100246', 'BRL01-FS014-261115-0002', '2026-11-15T03:32:00Z', 50000, 'bkash', { transactionRef: 'BKX1234567' })).status).toBe(201);
  await handIn(fs1); // October cash, today's cash and the bKash go to the ERP once handed in
  await dispatchOutbox();
  expect((await collect(fs1, '100246', 'BRL01-FS014-261115-0003', '2026-11-15T03:33:00Z', 20000, 'cash')).status).toBe(201); // still in hand
  expect((await collect(fsB, '200301', 'PTK01-FS101-261115-0001', '2026-11-15T03:34:00Z', 70000, 'cash')).status).toBe(201); // other branch

  expect((await visit(fs1, '100245', '2026-11-15T03:30:00Z', 'partial_paid')).status).toBe(201);
  expect((await visit(fs1, '100246', '2026-11-15T03:35:00Z', 'promised')).status).toBe(201);
  expect((await visit(fs1, '100245', '2026-11-10T05:00:00Z', 'not_home')).status).toBe(201);
  // Dhaka midnight: 17:55 UTC is still 14 November in Dhaka, 18:05 UTC is already the 15th.
  expect((await visit(fs2, '100247', '2026-11-14T17:55:00Z', 'not_home')).status).toBe(201);
  expect((await visit(fs2, '100248', '2026-11-14T18:05:00Z', 'not_home')).status).toBe(201);
  expect((await visit(fsB, '200301', '2026-11-15T03:30:00Z', 'paid')).status).toBe(201);

  const A = s.branchA;
  await mongoose.connection.collection('promises').insertMany([
    promiseDoc({ customer: '100245', branchId: A, ownerId: s.fs1.id, promisedDate: '2026-11-15', amount: 100000, status: 'open' }),
    promiseDoc({ customer: '100246', branchId: A, ownerId: s.fs1.id, promisedDate: '2026-11-20', amount: 40000, status: 'open' }),
    promiseDoc({ customer: '100247', branchId: A, ownerId: s.fs2.id, promisedDate: '2026-11-28', amount: 25000, status: 'open' }),
    promiseDoc({ customer: '100248', branchId: A, ownerId: s.fs2.id, promisedDate: '2026-12-15', amount: 99000, status: 'open' }), // beyond 15 days
    promiseDoc({ customer: '100245', branchId: A, ownerId: s.fs1.id, promisedDate: '2026-11-03', amount: 10000, status: 'kept' }),
    promiseDoc({ customer: '100246', branchId: A, ownerId: s.fs1.id, promisedDate: '2026-11-04', amount: 10000, status: 'broken' }), // no follow-up field at all
    promiseDoc({ customer: '100247', branchId: A, ownerId: s.fs2.id, promisedDate: '2026-11-05', amount: 10000, status: 'broken', followUpId: 'f'.repeat(24) }),
    promiseDoc({ customer: '100248', branchId: A, ownerId: s.fs2.id, promisedDate: '2026-11-06', amount: 10000, status: 'partially_kept', followUpId: null }),
    promiseDoc({ customer: '100245', branchId: A, ownerId: s.fs1.id, promisedDate: '2026-10-28', amount: 10000, status: 'broken' }), // before the range
    promiseDoc({ customer: '200301', branchId: s.branchB, ownerId: s.fsB.id, promisedDate: '2026-11-15', amount: 77000, status: 'open' }),
    promiseDoc({ customer: '200301', branchId: s.branchB, ownerId: s.fsB.id, promisedDate: '2026-11-05', amount: 77000, status: 'broken' }),
  ]);
  const session = (branchId: string, businessDate: string) => ({ branchId, businessDate, status: 'ended', createdBy: s.fs1.id, note: null, members: [], clientIds: [randomUUID()], createdAt: new Date(`${businessDate}T04:00:00Z`), endedAt: null, endedBy: null, endReason: null });
  await mongoose.connection.collection('cowork_sessions').insertMany([session(A, '2026-11-10'), session(A, '2026-10-10'), session(s.branchB, '2026-11-10')]);
  const proposal = (branchId: string, customer: string, status: string) => ({ clientId: randomUUID(), customerId: ids[customer], branchId, proposedBy: s.fs1.id, point: { type: 'Point', coordinates: [90.37, 22.71] }, accuracyM: 8, status, createdAt: new Date(NOW) });
  await mongoose.connection.collection('location_proposals').insertMany([proposal(A, '100245', 'pending'), proposal(A, '100246', 'approved'), proposal(s.branchB, '200301', 'pending')]);
  // Possible customers: one new in range, one converted in range (created in October), one in the other branch.
  const prospect = (branchId: string, createdDate: string, status: string, convertedDate: string | null = null) => ({
    clientId: randomUUID(), name: 'Possible', phones: [], address: null, note: null, location: null, branchId, createdBy: { id: s.fs1.id, name: 'Rakib Hasan' },
    createdAt: new Date(`${createdDate}T04:00:00Z`), createdDate, status, statusChangedAt: new Date(`${createdDate}T04:00:00Z`), convertedCustomerId: null, convertedErpCustomerId: null,
    convertedAt: convertedDate ? new Date(`${convertedDate}T04:00:00Z`) : null, convertedDate, convertedBy: null, fromProspectId: null, history: [], updatedAt: new Date(NOW), version: 1,
  });
  await mongoose.connection.collection('prospects').insertMany([prospect(A, '2026-11-10', 'new'), prospect(A, '2026-10-05', 'converted', '2026-11-12'), prospect(s.branchB, '2026-11-11', 'contacted')]);
});
afterAll(async () => t.close());

const MONTH = { from: '2026-11-01', to: '2026-11-15' };

describe('dashboard statistics (FR-DSH-002)', () => {
  it('fills every block for the default range (month of today) and conforms to the contract', async () => {
    const bm = await as(t, BM);
    const r = await bm.get('/dashboard/overview');
    expect(r.status).toBe(200);
    expectConforms('GET', '/dashboard/overview', 200, r.body);
    const b = r.body;
    expect(b.range).toEqual({ ...MONTH, days: 15 });
    // The old fields are unchanged.
    expect(b.collected).toMatchObject({ totalPoisha: 220000, cashPoisha: 170000, mobilePoisha: 50000, count: 3 });
    expect(b.trend7d).toHaveLength(7);

    // collections: branch A only (fsB's 70000 is another branch)
    expect(b.collections.today).toEqual({ amountPoisha: 220000, count: 3, link: { path: '/collections', query: { from: '2026-11-15', to: '2026-11-15' } } });
    expect(b.collections.thisMonth).toEqual({ amountPoisha: 220000, count: 3, link: { path: '/collections', query: MONTH } });
    expect(b.collections.previousMonth).toEqual({ amountPoisha: 30000, count: 1, link: { path: '/collections', query: { from: '2026-10-01', to: '2026-10-31' } } });
    expect(b.collections.inRange).toMatchObject({ amountPoisha: 220000, count: 3 });
    expect(b.collections.series).toHaveLength(15);
    expect(b.collections.series[14]).toEqual({ date: '2026-11-15', amountPoisha: 220000, count: 3 });
    expect(b.collections.series[0]).toEqual({ date: '2026-11-01', amountPoisha: 0, count: 0 });
    expect(b.collections.byMethod).toEqual([
      { method: 'cash', amountPoisha: 170000, count: 2, link: { path: '/collections', query: { ...MONTH, method: 'cash' } } },
      { method: 'bkash', amountPoisha: 50000, count: 1, link: { path: '/collections', query: { ...MONTH, method: 'bkash' } } },
    ]);
    expect(b.collections.erpPosted).toEqual({ amountPoisha: 200000, count: 2, link: { path: '/collections', query: { ...MONTH, status: 'posted' } } });
    expect(b.collections.pendingInField).toMatchObject({ amountPoisha: 20000, count: 1 });

    // visits: 15 Nov counts the 00:05 Dhaka visit, 14 Nov the 23:55 one
    expect(b.visitStats.total).toEqual({ count: 5, link: { path: '/visits', query: MONTH } });
    expect(b.visitStats.uniqueCustomers).toBe(4);
    const day = (d: string) => b.visitStats.series.find((x: { date: string }) => x.date === d).count;
    expect([day('2026-11-10'), day('2026-11-14'), day('2026-11-15')]).toEqual([1, 1, 3]);
    expect(b.visitStats.byOutcome[0]).toEqual({ outcome: 'not_home', count: 3, link: { path: '/visits', query: { ...MONTH, outcome: 'not_home' } } });

    // promises
    const p = b.promiseStats;
    expect(p.dueToday).toEqual({ amountPoisha: 100000, count: 1, link: { path: '/promises', query: { from: '2026-11-15', to: '2026-11-15', status: 'open' } } });
    expect(p.next7Days).toEqual({ amountPoisha: 140000, count: 2, link: { path: '/promises', query: { from: '2026-11-15', to: '2026-11-22', status: 'open' } } });
    expect(p.next15Days).toMatchObject({ amountPoisha: 165000, count: 3, link: { path: '/promises', query: { from: '2026-11-15', to: '2026-11-30', status: 'open' } } });
    expect([p.kept.count, p.partiallyKept.count, p.broken.count]).toEqual([1, 1, 2]);
    expect(p.kept.link).toEqual({ path: '/promises', query: { ...MONTH, status: 'kept' } });
    expect(p.keptRate).toBe(0.25);
    expect(p.brokenRate).toBe(0.5);
    expect(p.brokenWithoutFollowUp).toEqual({ count: 2, link: { path: '/promises', query: { ...MONTH, brokenWithoutFollowUp: 'true' } } });

    // customers
    expect(b.overdueCustomers).toEqual({ amountPoisha: b.overdue.amountPoisha, count: b.overdue.customers, link: { path: '/customers', query: { filter: 'overdue' } } });
    expect(b.payStates.map((x: { payState: string }) => x.payState)).toEqual(['bad', 'missed_many', 'missed_one', 'due_today', 'on_track', 'paid_off']);
    expect(b.payStates.reduce((n: number, x: { count: number }) => n + x.count, 0)).toBe(4); // four branch-A customers
    expect(b.payStates[0].link).toEqual({ path: '/customers', query: { payState: 'bad' } });
    expect(b.pinApprovals).toEqual({ count: 1, link: { path: '/location-proposals', query: { status: 'pending' } } });

    // top staff
    expect(b.topStaff.byCollection).toEqual([{ userId: s.fs1.id, name: 'Rakib Hasan', amountPoisha: 220000, count: 3, link: { path: '/collections', query: { ...MONTH, collectorId: s.fs1.id } } }]);
    expect(b.topStaff.byVisits.map((x: { userId: string; count: number }) => [x.userId, x.count])).toEqual([
      [s.fs1.id, 3],
      [s.fs2.id, 2],
    ]);
    expect(b.topStaff.byVisits[1].link).toEqual({ path: '/visits', query: { ...MONTH, userId: s.fs2.id } });

    // now-figures
    expect(b.attendanceToday.present.count).toBe(1);
    expect(b.attendanceToday.present.link).toEqual({ path: '/attendance/days', query: { from: '2026-11-15', to: '2026-11-15' } });
    expect(b.attendanceToday.onDutyNow.count).toBe(b.attendance.onDutyNow);
    expect(b.cashInHand).toEqual({ amountPoisha: 20000, count: 1, link: { path: '/cash/positions', query: {} } });
    expect(b.cashInHand.amountPoisha).toBe(b.cash.onHandPoisha);
    expect(b.coworkStats.sessions).toEqual({ count: 1, link: { path: '/cowork/sessions', query: MONTH } });
    expect(b.prospectStats.created).toEqual({ count: 1, link: { path: '/prospects', query: MONTH } });
    expect(b.prospectStats.converted).toEqual({ count: 1, link: { path: '/prospects', query: { status: 'converted' } } });
    expect(b.prospectStats.openNow.count).toBe(1);
  });

  it('links open the list behind the number', async () => {
    const bm = await as(t, BM);
    const b = (await bm.get('/dashboard/overview')).body;
    const open = (l: { path: string; query: Record<string, string> }) => bm.get(`${l.path}?${new URLSearchParams(l.query).toString()}`);
    expect((await open(b.collections.inRange.link)).body.items).toHaveLength(b.collections.inRange.count);
    expect((await open(b.collections.byMethod[0].link)).body.items).toHaveLength(b.collections.byMethod[0].count);
    expect((await open(b.visitStats.total.link)).body.items).toHaveLength(b.visitStats.total.count);
    expect((await open(b.promiseStats.kept.link)).body.items).toHaveLength(b.promiseStats.kept.count);
    expect((await open(b.promiseStats.next7Days.link)).body.items).toHaveLength(b.promiseStats.next7Days.count);
    expect((await open(b.pinApprovals.link)).body).toHaveLength(b.pinApprovals.count);
    expect((await open(b.coworkStats.sessions.link)).body.items).toHaveLength(b.coworkStats.sessions.count);
    for (const ps of b.payStates) expect((await open({ ...ps.link, query: { ...ps.link.query, includeTotal: 'true' } })).body.total).toBe(ps.count);
  });

  it('from / to set the range; the today and month figures do not move', async () => {
    const bm = await as(t, BM);
    const r = await bm.get('/dashboard/overview?from=2026-11-14&to=2026-11-14');
    expect(r.status).toBe(200);
    expectConforms('GET', '/dashboard/overview', 200, r.body);
    expect(r.body.range).toEqual({ from: '2026-11-14', to: '2026-11-14', days: 1 });
    expect(r.body.visitStats.total.count).toBe(1); // only the 23:55 Dhaka visit
    expect(r.body.collections.inRange.count).toBe(0);
    expect(r.body.collections.series).toEqual([{ date: '2026-11-14', amountPoisha: 0, count: 0 }]);
    expect(r.body.collections.today.amountPoisha).toBe(220000);
    expect(r.body.promiseStats.dueToday.count).toBe(1);
    expect(r.body.topStaff.byCollection).toEqual([]);
    // October range: last month's collection, the old broken promise and the October session
    const oct = (await bm.get('/dashboard/overview?from=2026-10-01&to=2026-10-31')).body;
    expect(oct.collections.inRange).toMatchObject({ amountPoisha: 30000, count: 1 });
    expect(oct.promiseStats.broken.count).toBe(1);
    expect(oct.coworkStats.sessions.count).toBe(1);
    // `date` alone moves the default range to that month
    const d = (await bm.get('/dashboard/overview?date=2026-10-20')).body;
    expect(d.range).toEqual({ from: '2026-10-01', to: '2026-10-20', days: 20 });
    // 366 days (inclusive) is the most allowed
    expect((await bm.get('/dashboard/overview?from=2025-11-15&to=2026-11-15')).status).toBe(200);
  });

  it('bad from / to are 400 VALIDATION_FAILED', async () => {
    const bm = await as(t, BM);
    for (const q of ['from=2026-11-10&to=2026-11-01', 'to=2026-11-16', 'from=2025-11-14&to=2026-11-15', 'from=2026-13-01', 'from=yesterday', 'to=2026-11-15T00:00']) {
      const r = await bm.get(`/dashboard/overview?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.body.code, q).toBe('VALIDATION_FAILED');
      expectConforms('GET', '/dashboard/overview', 400, r.body);
    }
  });

  it('401 without a token, 403 without report.view, 404 for a branch out of scope', async () => {
    const anon = await client(t.app).get('/dashboard/overview');
    expect(anon.status).toBe(401);
    expect((await (await as(t, FS1)).get('/dashboard/overview')).status).toBe(403);
    const bm = await as(t, BM);
    const r = await bm.get(`/dashboard/overview?branchId=${s.branchB}`);
    expect(r.status).toBe(404);
    expectConforms('GET', '/dashboard/overview', 404, r.body);
  });

  it('a branch manager never counts another branch; a super admin narrows by branchId and links carry it', async () => {
    const sa = await as(t, SA);
    const all = (await sa.get('/dashboard/overview')).body;
    expect(all.collections.today.amountPoisha).toBe(290000);
    expect(all.visitStats.total.count).toBe(6);
    expect(all.pinApprovals.count).toBe(2);
    expect(all.coworkStats.sessions.count).toBe(2);
    expect(all.promiseStats.broken.count).toBe(3);
    const r = await sa.get(`/dashboard/overview?branchId=${s.branchB}`);
    expect(r.status).toBe(200);
    expectConforms('GET', '/dashboard/overview', 200, r.body);
    const b = r.body;
    expect(b.collections.today).toEqual({ amountPoisha: 70000, count: 1, link: { path: '/collections', query: { branchId: s.branchB, from: '2026-11-15', to: '2026-11-15' } } });
    expect(b.collections.previousMonth.count).toBe(0);
    expect(b.visitStats.total.count).toBe(1);
    expect(b.promiseStats.dueToday).toMatchObject({ amountPoisha: 77000, count: 1 });
    expect(b.promiseStats.brokenWithoutFollowUp.count).toBe(1);
    expect(b.topStaff.byCollection.map((x: { userId: string }) => x.userId)).toEqual([s.fsB.id]);
    expect(b.pinApprovals).toEqual({ count: 1, link: { path: '/location-proposals', query: { branchId: s.branchB, status: 'pending' } } });
    expect(b.cashInHand.link).toEqual({ path: '/cash/positions', query: { branchId: s.branchB } });
    expect(b.payStates.reduce((n: number, x: { count: number }) => n + x.count, 0)).toBe(1);
  });

  it('switched-off modules give zeros and empty lists', async () => {
    const { setFlagSystem } = await import('../../src/modules/flags/index.js');
    for (const f of ['module.collections', 'module.visits', 'module.promises', 'module.cowork', 'module.cash', 'module.attendance', 'module.prospects']) await setFlagSystem(f, false);
    try {
      const bm = await as(t, BM);
      const r = await bm.get('/dashboard/overview');
      expect(r.status).toBe(200);
      expectConforms('GET', '/dashboard/overview', 200, r.body);
      expect(r.body.collections.inRange.amountPoisha).toBe(0);
      expect(r.body.collections.byMethod).toEqual([]);
      expect(r.body.visitStats.byOutcome).toEqual([]);
      expect(r.body.promiseStats.keptRate).toBeNull();
      expect(r.body.topStaff).toEqual({ byCollection: [], byVisits: [] });
      expect(r.body.attendanceToday.present.count).toBe(0);
      expect(r.body.cashInHand.amountPoisha).toBe(0);
      expect(r.body.coworkStats.sessions.count).toBe(0);
      expect(r.body.prospectStats.created.count).toBe(0);
    } finally {
      for (const f of ['module.collections', 'module.visits', 'module.promises', 'module.cowork', 'module.cash', 'module.attendance', 'module.prospects']) await setFlagSystem(f, true);
    }
  });

  it('Dhaka midnight (18:00 UTC): "today" and the default range turn over at Dhaka midnight, not UTC', async () => {
    try {
      t.clock.set('2026-11-14T17:59:00Z'); // 23:59 Dhaka, 14 November
      const bm = await as(t, BM);
      const before = await bm.get('/dashboard/overview');
      expect(before.body.range).toEqual({ from: '2026-11-01', to: '2026-11-14', days: 14 });
      expect(before.body.collections.today.link.query).toEqual({ from: '2026-11-14', to: '2026-11-14' });
      expect(before.body.visitStats.series.at(-1)).toEqual({ date: '2026-11-14', count: 1 });
      expect((await bm.get('/dashboard/overview?to=2026-11-15')).status).toBe(400); // tomorrow in Dhaka
      t.clock.set('2026-11-14T18:00:00Z'); // 00:00 Dhaka, 15 November
      const bm2 = await as(t, BM);
      const after = await bm2.get('/dashboard/overview?to=2026-11-15');
      expect(after.status).toBe(200);
      expect(after.body.range.to).toBe('2026-11-15');
      expect(after.body.collections.today.link.query).toEqual({ from: '2026-11-15', to: '2026-11-15' });
      expect(after.body.promiseStats.dueToday.link.query.from).toBe('2026-11-15');
    } finally {
      t.clock.set(NOW);
    }
  });
});
