import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { applyAssignments, getByErpId } from '../../src/modules/customers/index.js';
import { setSystem } from '../../src/modules/settings/index.js';

let t: TestApp;
let s: Seeded;
let cust = '';
let seq = 0;
const collect = async (c: Awaited<ReturnType<typeof as>>, amountPoisha: number, method = 'cash', extra: Record<string, unknown> = {}) =>
  c.post(
    '/collections',
    { clientId: randomUUID(), customerId: cust, amountPoisha, method, receiptNo: `BRL01-FS014-261115-${String(++seq).padStart(4, '0')}`, recordedAt: '2026-11-15T03:00:00Z', geo: { lat: 22.7, lng: 90.36, accuracyM: 10 }, ...extra },
    { 'idempotency-key': randomUUID() },
  );

beforeAll(async () => {
  t = await createTestApp();
  s = await seedBasics(t);
  await deltaSync();
  cust = (await getByErpId('100246'))!.id;
  await applyAssignments([{ customerId: cust, assigneeId: s.fs1.id }]);
  await setSystem('cash.limitPoisha', 1_000_000); // 10,000 BDT for the test
});
afterAll(async () => t.close());

describe('cash on hand (FR-CASH-001/002)', () => {
  it('counts cash only, warns at 80 %, collection response carries the position', async () => {
    const fs = await as(t, '01700000003');
    const events: unknown[] = [];
    t.ctx.bus.on('cash.limit_reached', async (p) => void events.push(p));
    await collect(fs, 500_000);
    await collect(fs, 200_000, 'bkash', { transactionRef: 'AB12CD34EF' });
    const r = await collect(fs, 350_000);
    expect(r.body.cashOnHand).toMatchObject({ onHandPoisha: 850_000, state: 'warning' });
    expect(events).toHaveLength(1);
    const me = await fs.get('/cash/me');
    expectConforms('GET', '/cash/me', 200, me.body);
    expect(me.body).toMatchObject({ onHandPoisha: 850_000, todayCashPoisha: 850_000, todayMobilePoisha: 200_000, limitPoisha: 1_000_000 });
    expect(me.body.oldestUndepositedAt).toBe('2026-11-15T03:00:00.000Z');
  });
});

describe('deposits (FR-CASH-003/004)', () => {
  let depId = '';
  it('records a deposit (idempotent), bank needs a slip, cannot exceed on hand', async () => {
    const fs = await as(t, '01700000003');
    const key = randomUUID();
    const b = { clientId: randomUUID(), amountPoisha: 500_000, destination: 'branch_cashier', depositedAt: '2026-11-15T09:00:00Z' };
    const r = await fs.post('/cash/deposits', b, { 'idempotency-key': key });
    expect(r.status).toBe(201);
    expectConforms('POST', '/cash/deposits', 201, r.body);
    depId = r.body.id;
    expect((await fs.post('/cash/deposits', b, { 'idempotency-key': key })).status).toBe(200);
    expect((await fs.post('/cash/deposits', { ...b, clientId: randomUUID(), destination: 'bank' }, { 'idempotency-key': randomUUID() })).body.details.rule).toBe('SLIP_REQUIRED');
    expect((await fs.post('/cash/deposits', { ...b, clientId: randomUUID(), amountPoisha: 9_000_000 }, { 'idempotency-key': randomUUID() })).body.details.rule).toBe('DEPOSIT_EXCEEDS_ON_HAND');
    expect((await fs.get('/cash/me')).body).toMatchObject({ onHandPoisha: 350_000, pendingDepositsPoisha: 500_000 });
  });

  it('staff cannot verify; manager rejects with reason → cash back on hand', async () => {
    expect((await (await as(t, '01700000003')).post(`/cash/deposits/${depId}/verify`)).status).toBe(403);
    const bm = await as(t, '01700000002');
    expect((await bm.post(`/cash/deposits/${depId}/reject`, {})).status).toBe(400);
    const r = await bm.post(`/cash/deposits/${depId}/reject`, { reason: 'Cashier did not receive it' });
    expect(r.body.status).toBe('rejected');
    expect((await bm.post(`/cash/deposits/${depId}/verify`)).status).toBe(409);
    const pos = await bm.get('/cash/positions');
    expectConforms('GET', '/cash/positions', 200, pos.body);
    expect(pos.body.find((p: { userId: string }) => p.userId === s.fs1.id).onHandPoisha).toBe(850_000);
  });

  it('other branch manager cannot see the deposit', async () => {
    const fsB = await as(t, '01700000005');
    expect((await fsB.get('/cash/deposits')).body.items).toHaveLength(0);
  });

  it('end-of-day closing snapshots the day', async () => {
    const fs = await as(t, '01700000003');
    const r = await fs.post('/cash/closings', { businessDate: '2026-11-15' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ onHandPoisha: 850_000, cashCollectedPoisha: 850_000, mobileCollectedPoisha: 200_000 });
  });
});

describe('cash in hand, collection by collection (FR-CASH-007)', () => {
  it('lists the collections deposits have not covered, newest first; managers read staff in scope, staff only their own', async () => {
    const fs = await as(t, '01700000003');
    expect((await collect(fs, 100_000, 'cash', { recordedAt: '2026-11-15T03:10:00Z' })).status).toBe(201);
    const before = await fs.get('/cash/me/collections');
    expect(before.status).toBe(200);
    expectConforms('GET', '/cash/me/collections', 200, before.body);
    expect(before.body).toMatchObject({ userId: s.fs1.id, onHandPoisha: 950_000, pendingDepositsPoisha: 0, count: 3 });
    // the bKash collection is not cash; the newest cash comes first
    expect(before.body.items.map((i: { amountPoisha: number }) => i.amountPoisha).sort()).toEqual([100_000, 350_000, 500_000]);
    expect(before.body.items[0]).toMatchObject({ receiptNo: 'BRL01-FS014-261115-0004', amountPoisha: 100_000, inHandPoisha: 100_000, businessDate: '2026-11-15', customer: { id: cust } });
    expect(before.body.items[0].erpPlanId).toBeTruthy();
    expect(before.body.items[0].customer.name.bn || before.body.items[0].customer.name.en).toBeTruthy();

    // 6,000 BDT handed in: the oldest collections are paid off first, one of them only partly
    const dep = await fs.post('/cash/deposits', { clientId: randomUUID(), amountPoisha: 600_000, destination: 'branch_cashier', depositedAt: '2026-11-15T09:30:00Z' }, { 'idempotency-key': randomUUID() });
    expect(dep.status).toBe(201);
    const after = await fs.get('/cash/me/collections');
    expectConforms('GET', '/cash/me/collections', 200, after.body);
    expect(after.body).toMatchObject({ onHandPoisha: 350_000, pendingDepositsPoisha: 600_000, count: 2 });
    expect(after.body.items.map((i: { inHandPoisha: number }) => i.inHandPoisha)).toEqual([100_000, 250_000]);
    expect(after.body.items[1].amountPoisha).toBeGreaterThan(250_000);
    expect((await fs.get('/cash/me')).body.onHandPoisha).toBe(350_000); // the list and the position agree

    const bm = await as(t, '01700000002');
    const seen = await bm.get(`/cash/positions/${s.fs1.id}/collections`);
    expect(seen.status).toBe(200);
    expectConforms('GET', '/cash/positions/{id}/collections', 200, seen.body);
    expect(seen.body).toMatchObject({ userId: s.fs1.id, onHandPoisha: 350_000, count: 2 });
    expect((await bm.get(`/cash/positions/${s.fsB.id}/collections`)).status).toBe(404); // another branch
    expect((await bm.get('/cash/positions/nope/collections')).status).toBe(404);
    expect((await fs.get(`/cash/positions/${s.fs2.id}/collections`)).status).toBe(404); // a colleague
    expect((await fs.get(`/cash/positions/${s.fs1.id}/collections`)).status).toBe(200);
    const nothing = await (await as(t, '01700000004')).get('/cash/me/collections');
    expect(nothing.body).toMatchObject({ onHandPoisha: 0, pendingDepositsPoisha: 0, count: 0, items: [] });
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/cash/me/collections' })).statusCode).toBe(401);
  });
});
