import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { applyAssignments, getByErpId } from '../../src/modules/customers/index.js';

let t: TestApp;
let s: Seeded;
const ids: Record<string, string> = {};
const geo = { lat: 22.7106, lng: 90.3703, accuracyM: 9 };
let depositId = '';

beforeAll(async () => {
  t = await createTestApp();
  s = await seedBasics(t);
  await deltaSync();
  for (const e of ['100245', '100246']) ids[e] = (await getByErpId(e))!.id;
  await applyAssignments([
    { customerId: ids['100245']!, assigneeId: s.fs1.id },
    { customerId: ids['100246']!, assigneeId: s.fs1.id },
  ]);
  const fs = await as(t, '01700000003');
  await fs.post('/attendance/events', { clientId: randomUUID(), type: 'work_in', at: '2026-11-15T03:00:00Z', geo });
  await fs.post('/visits', { clientId: randomUUID(), customerId: ids['100245'], checkInAt: '2026-11-15T03:30:00Z', outcome: 'partial_paid', geo });
  // mock GPS → flagged collection → inbox item
  await fs.post('/collections', { clientId: randomUUID(), customerId: ids['100246'], amountPoisha: 150000, method: 'cash', recordedAt: '2026-11-15T03:35:00Z', receiptNo: 'BRL01-FS014-261115-0001', geo: { ...geo, mock: true } }, { 'idempotency-key': randomUUID() });
  await fs.post('/collections', { clientId: randomUUID(), customerId: ids['100246'], amountPoisha: 50000, method: 'bkash', transactionRef: 'BKX1234567', recordedAt: '2026-11-15T03:40:00Z', receiptNo: 'BRL01-FS014-261115-0002', geo }, { 'idempotency-key': randomUUID() });
  await fs.post('/promises', { clientId: randomUUID(), customerId: ids['100245'], promisedDate: '2026-11-15', promisedAmountPoisha: 100000 });
  // 1.35.0: a deposit hands in all of it (the cash and the bKash collection) and is final
  const dep = await fs.post('/cash/deposits', { clientId: randomUUID(), amountPoisha: 150000, destination: 'branch_cashier', depositedAt: '2026-11-15T03:50:00Z' }, { 'idempotency-key': randomUUID() });
  depositId = dep.body.id;
  await fs.post('/leave-requests', { type: 'casual', from: '2026-11-20', to: '2026-11-20' });
});
afterAll(async () => t.close());

describe('inbox (FR-INB-001)', () => {
  it('collects exceptions from events, scoped to the branch, most severe first', async () => {
    const bm = await as(t, '01700000002');
    const r = await bm.get('/inbox');
    expect(r.status).toBe(200);
    expectConforms('GET', '/inbox', 200, r.body);
    const types = r.body.items.map((i: { type: string }) => i.type);
    expect(types).toContain('collection.flagged');
    expect(types).toContain('leave.requested');
    expect(types).not.toContain('cash.deposit.pending'); // only after 24 h
    expect(r.body.counts['collection.flagged']).toBe(1);
    const ranks = r.body.items.map((i: { severity: string }) => ['low', 'medium', 'high', 'critical'].indexOf(i.severity));
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
    expect((await (await as(t, '01700000003')).get('/inbox')).status).toBe(403);
    expect((await bm.get(`/inbox?branchId=${'a'.repeat(24)}`)).body.items).toEqual([]);
  });

  it('1.35.0: a final deposit never waits for the office, so no "unverified deposit" item appears, even after 24 h', async () => {
    expect(depositId).toBeTruthy();
    t.clock.advance(25 * 3_600_000);
    const bm2 = await as(t, '01700000002');
    expect((await bm2.get('/inbox?type=cash.deposit.pending')).body.items).toHaveLength(0);
    expect((await bm2.get('/inbox?status=resolved&type=cash.deposit.pending')).body.items).toHaveLength(0);
  });

  it('snooze hides until the time passes; resolve is audited and idempotent; out of scope is 404', async () => {
    const bm = await as(t, '01700000002');
    const item = (await bm.get('/inbox?type=collection.flagged')).body.items[0];
    const until = new Date(t.clock.now().getTime() + 3_600_000).toISOString();
    expect((await bm.post(`/inbox/${item.id}/snooze`, { until: '2020-01-01T00:00:00Z' })).status).toBe(400);
    expect((await bm.post(`/inbox/${item.id}/snooze`, { until })).status).toBe(200);
    expect((await bm.get('/inbox?type=collection.flagged')).body.items).toHaveLength(0);
    t.clock.advance(2 * 3_600_000);
    const bm2 = await as(t, '01700000002');
    expect((await bm2.get('/inbox?type=collection.flagged')).body.items).toHaveLength(1);
    const done = await bm2.post(`/inbox/${item.id}/resolve`, { reason: 'Checked with the collector' });
    expect(done.body.status).toBe('resolved');
    expect((await bm2.post(`/inbox/${item.id}/resolve`, {})).status).toBe(200);
    expect((await bm2.post(`/inbox/${item.id}/snooze`, { until: new Date(t.clock.now().getTime() + 3_600_000).toISOString() })).status).toBe(409);
    expect((await bm2.post(`/inbox/${'a'.repeat(24)}/resolve`, {})).status).toBe(404);
  });
});

describe('dashboard (FR-DSH-001)', () => {
  it('summarises the day in scope and conforms to the contract', async () => {
    const bm = await as(t, '01700000002');
    const r = await bm.get('/dashboard/overview?date=2026-11-15');
    expect(r.status).toBe(200);
    expectConforms('GET', '/dashboard/overview', 200, r.body);
    expect(r.body.collected).toMatchObject({ totalPoisha: 200000, cashPoisha: 150000, mobilePoisha: 50000, count: 2 });
    expect(r.body.visits).toEqual({ count: 1, uniqueCustomers: 1, credit: 1, target: 0 }); // no target set in this test
    expect(r.body.promises.dueToday).toBe(1);
    expect(r.body.trend7d).toHaveLength(7);
    expect(r.body.trend7d[6]).toEqual({ date: '2026-11-15', collectedPoisha: 200000, visits: 1 });
    expect(r.body.overdue.customers).toBeGreaterThanOrEqual(0);
    const today = await bm.get('/dashboard/overview');
    expect(today.body.cash.onHandPoisha).toBe(0); // all 150000 cash handed in
    expect((await bm.get('/dashboard/overview?date=2030-01-01')).status).toBe(400);
    expect((await bm.get(`/dashboard/overview?branchId=${'a'.repeat(24)}`)).status).toBe(404);
    expect((await (await as(t, '01700000003')).get('/dashboard/overview')).status).toBe(403);
  });
});

describe('global search (FR-SRCH-001)', () => {
  it('finds customers, staff and receipts the caller may see', async () => {
    const bm = await as(t, '01700000002');
    const r = await bm.get('/search?q=BRL01-FS014');
    expect(r.status).toBe(200);
    expectConforms('GET', '/search', 200, r.body);
    expect(r.body.filter((x: { type: string }) => x.type === 'receipt')).toHaveLength(2);
    const staff = await bm.get('/search?q=FS014&types=user');
    expect(staff.body.every((x: { type: string }) => x.type === 'user')).toBe(true);
    expect(staff.body.length).toBeGreaterThan(0);
    expect(JSON.stringify(staff.body)).not.toContain('0170000');
    const cust = await bm.get('/search?q=100245&types=customer');
    expect(cust.body[0].type).toBe('customer');
    expect((await bm.get('/search?q=a')).status).toBe(400);
    expect((await bm.get('/search?q=abc&types=spaceship')).status).toBe(400);
    // field staff: no user search, only own receipts
    const fs2 = await as(t, '01700000004');
    expect((await fs2.get('/search?q=BRL01-FS014')).body).toEqual([]);
  });
});
