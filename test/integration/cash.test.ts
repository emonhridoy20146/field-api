import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { applyAssignments, getByErpId } from '../../src/modules/customers/index.js';
import { setSystem } from '../../src/modules/settings/index.js';
import { dispatchOutbox } from '../../src/core/events/outbox.js';
import { DepositModel } from '../../src/modules/cash/models/cash.model.js';
import { linkLegacyDeposits } from '../../src/modules/cash/service.js';

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
  // several collections on one invoice in a day (OD-27 granted here)
  t.erp.allowSameDay = true;
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

describe('deposits (FR-CASH-003, 1.35.0 FR-CASH-010)', () => {
  let depId = '';
  it('nothing goes to the ERP before a deposit; a deposit hands in everything at once and sends it', async () => {
    const fs = await as(t, '01700000003');
    await dispatchOutbox();
    expect(t.erp.postCalls).toBe(0); // three collections, all still in hand
    const b = { clientId: randomUUID(), amountPoisha: 850_000, destination: 'branch_cashier', depositedAt: '2026-11-15T09:00:00Z' };
    const part = await fs.post('/cash/deposits', { ...b, clientId: randomUUID(), amountPoisha: 500_000 }, { 'idempotency-key': randomUUID() });
    expect(part.status).toBe(422);
    expect(part.body.details).toMatchObject({ rule: 'DEPOSIT_MUST_BE_ALL', onHandPoisha: 850_000 });
    expect((await fs.post('/cash/deposits', { ...b, clientId: randomUUID(), destination: 'bank' }, { 'idempotency-key': randomUUID() })).body.details.rule).toBe('SLIP_REQUIRED');
    expect((await fs.post('/cash/deposits', { ...b, clientId: randomUUID(), amountPoisha: 9_000_000 }, { 'idempotency-key': randomUUID() })).body.details.rule).toBe('DEPOSIT_EXCEEDS_ON_HAND');
    const key = randomUUID();
    const r = await fs.post('/cash/deposits', b, { 'idempotency-key': key });
    expect(r.status).toBe(201);
    expectConforms('POST', '/cash/deposits', 201, r.body);
    // the cash and the bKash collection; final at once, nobody confirms it
    expect(r.body).toMatchObject({ status: 'submitted', amountPoisha: 850_000, collectionCount: 3, nonCashPoisha: 200_000, nonCashCount: 1 });
    depId = r.body.id;
    expect((await fs.post('/cash/deposits', b, { 'idempotency-key': key })).status).toBe(200);
    expect((await fs.get('/cash/me')).body).toMatchObject({ onHandPoisha: 0, pendingDepositsPoisha: 0 });
    await dispatchOutbox();
    expect(t.erp.postCalls).toBe(3);
    const mine = (await fs.get('/collections?limit=10')).body.items as { status: string; depositId: string | null; depositedAt: string | null }[];
    expect(mine.filter((c) => c.depositId === depId)).toHaveLength(3);
    expect(mine.filter((c) => c.depositId === depId).every((c) => c.status === 'posted' && !!c.depositedAt)).toBe(true);
    const again = await fs.post('/cash/deposits', { ...b, clientId: randomUUID(), amountPoisha: 0 }, { 'idempotency-key': randomUUID() });
    expect(again.body.details.rule).toBe('NOTHING_TO_DEPOSIT');
    expect((await fs.get('/cash/deposits?status=submitted')).body.items.map((d: { id: string }) => d.id)).toEqual([depId]);
  });

  it('nobody verifies, rejects or deletes a deposit any more (409 DEPOSIT_FINAL)', async () => {
    expect((await (await as(t, '01700000003')).post(`/cash/deposits/${depId}/verify`)).status).toBe(403);
    const bm = await as(t, '01700000002');
    for (const [path, b] of [['verify', undefined], ['reject', { reason: 'Cashier did not receive it' }], ['delete', { reason: 'Entered by mistake' }]] as const) {
      const r = await bm.post(`/cash/deposits/${depId}/${path}`, b);
      expect(r.status, path).toBe(409);
      expect(r.body.details).toMatchObject({ reason: 'DEPOSIT_FINAL', status: 'submitted' });
    }
    expect((await bm.post('/cash/deposits/aaaaaaaaaaaaaaaaaaaaaaaa/verify')).status).toBe(404);
    expect((await bm.get('/cash/deposits')).body.items.find((d: { id: string }) => d.id === depId).status).toBe('submitted');
  });

  it('other branch manager cannot see the deposit', async () => {
    const fsB = await as(t, '01700000005');
    expect((await fsB.get('/cash/deposits')).body.items).toHaveLength(0);
  });

  it('end-of-day closing snapshots the day', async () => {
    const fs = await as(t, '01700000003');
    const r = await fs.post('/cash/closings', { businessDate: '2026-11-15' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ onHandPoisha: 0, cashCollectedPoisha: 850_000, mobileCollectedPoisha: 200_000, depositedPoisha: 850_000 });
  });
});

describe('cash in hand, collection by collection (FR-CASH-007)', () => {
  it('lists the collections not handed in yet, newest first; managers read staff in scope, staff only their own', async () => {
    const fs = await as(t, '01700000003');
    expect((await collect(fs, 100_000, 'cash', { recordedAt: '2026-11-15T03:10:00Z' })).status).toBe(201);
    const before = await fs.get('/cash/me/collections');
    expect(before.status).toBe(200);
    expectConforms('GET', '/cash/me/collections', 200, before.body);
    expect(before.body).toMatchObject({ userId: s.fs1.id, onHandPoisha: 100_000, pendingDepositsPoisha: 0, count: 1 });
    expect(before.body.items[0]).toMatchObject({ receiptNo: 'BRL01-FS014-261115-0004', amountPoisha: 100_000, inHandPoisha: 100_000, businessDate: '2026-11-15', customer: { id: cust } });
    expect(before.body.items[0].erpPlanId).toBeTruthy();
    expect(before.body.items[0].customer.name.bn || before.body.items[0].customer.name.en).toBeTruthy();
    expect((await fs.get('/cash/me')).body.onHandPoisha).toBe(100_000); // the list and the position agree

    const bm = await as(t, '01700000002');
    const seen = await bm.get(`/cash/positions/${s.fs1.id}/collections`);
    expect(seen.status).toBe(200);
    expectConforms('GET', '/cash/positions/{id}/collections', 200, seen.body);
    expect(seen.body).toMatchObject({ userId: s.fs1.id, onHandPoisha: 100_000, count: 1 });
    expect((await bm.get(`/cash/positions/${s.fsB.id}/collections`)).status).toBe(404); // another branch
    expect((await bm.get('/cash/positions/nope/collections')).status).toBe(404);
    expect((await fs.get(`/cash/positions/${s.fs2.id}/collections`)).status).toBe(404); // a colleague
    expect((await fs.get(`/cash/positions/${s.fs1.id}/collections`)).status).toBe(200);
    const nothing = await (await as(t, '01700000004')).get('/cash/me/collections');
    expect(nothing.body).toMatchObject({ onHandPoisha: 0, pendingDepositsPoisha: 0, count: 0, items: [] });
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/cash/me/collections' })).statusCode).toBe(401);
  });
});

describe('which collections a deposit covered; the promise behind each line (FR-CASH-008, contract 1.30.0)', () => {
  type Item = { collectionId: string; amountPoisha: number; method?: string; status?: string; coveredPoisha?: number; inHandPoisha?: number; promise: null | { id: string; promisedDate: string; status: string; onTime: boolean } };

  it('a 1.35.0 deposit lists every collection it handed in, with method and ERP state', async () => {
    const fs = await as(t, '01700000003');
    const dep = ((await fs.get('/cash/deposits?status=submitted')).body.items as { id: string }[])[0]!;
    const r = await fs.get(`/cash/deposits/${dep.id}/collections`);
    expect(r.status).toBe(200);
    expectConforms('GET', '/cash/deposits/{id}/collections', 200, r.body);
    expect(r.body.deposit).toMatchObject({ id: dep.id, amountPoisha: 850_000, status: 'submitted', userId: s.fs1.id });
    const items = r.body.items as Item[];
    expect(items.map((i) => [i.amountPoisha, i.method, i.status])).toEqual([[500_000, 'cash', 'posted'], [200_000, 'bkash', 'posted'], [350_000, 'cash', 'posted']]);
    expect(r.body).toMatchObject({ coveredPoisha: 850_000, unmatchedPoisha: 0 });
    // scope follows the deposit: own branch manager yes, the other branch and a colleague 404, unknown 404
    expect((await (await as(t, '01700000002')).get(`/cash/deposits/${dep.id}/collections`)).status).toBe(200);
    expect((await (await as(t, '01700000005')).get(`/cash/deposits/${dep.id}/collections`)).status).toBe(404);
    expect((await (await as(t, '01700000004')).get(`/cash/deposits/${dep.id}/collections`)).status).toBe(404);
    expect((await fs.get('/cash/deposits/nope/collections')).status).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/cash/deposits/${dep.id}/collections` })).statusCode).toBe(401);
  });

  it('a deposit from before 1.35.0 covers the oldest cash first; the migration sends what it covered in full, the rest goes with the next deposit', async () => {
    const fs2 = await as(t, '01700000004');
    const plan = ((await (await as(t, '01700000003')).get('/cash/me/collections')).body.items as { erpPlanId: string }[])[0]!.erpPlanId;
    const mk = (amountPoisha: number, n: number, at: string) =>
      fs2.post('/collections', { clientId: randomUUID(), customerId: cust, erpPlanId: plan, amountPoisha, method: 'cash', receiptNo: `BRL01-FS015-261115-070${n}`, recordedAt: at, geo: { lat: 22.7, lng: 90.36, accuracyM: 10 } }, { 'idempotency-key': randomUUID() });
    const a = await mk(300_000, 1, '2026-11-15T02:00:00Z');
    const b = await mk(200_000, 2, '2026-11-15T02:30:00Z');
    expect([a.status, b.status]).toEqual([201, 201]);
    // as an older app recorded it: pending, an amount, no list of collections
    const legacy = await DepositModel.create({ clientId: randomUUID(), branchId: s.branchA, userId: s.fs2.id, amountPoisha: 400_000, destination: 'branch_cashier', depositedAt: new Date('2026-11-15T04:00:00Z'), status: 'pending', createdAt: new Date('2026-11-15T04:00:00Z') });
    const cov = await fs2.get(`/cash/deposits/${legacy._id.toHexString()}/collections`);
    expect((cov.body.items as Item[]).map((i) => [i.amountPoisha, i.coveredPoisha])).toEqual([[300_000, 300_000], [200_000, 100_000]]);
    expect((await fs2.get('/cash/me')).body.onHandPoisha).toBe(100_000);
    // the part-covered one cannot be changed either
    expect((await fs2.post(`/collections/${b.body.id}/withdraw`, {})).body.details.reason).toBe('COVERED_BY_DEPOSIT');

    const calls = t.erp.postCalls;
    expect(await linkLegacyDeposits()).toBe(1);
    expect(await linkLegacyDeposits()).toBe(0); // safe to run again
    await dispatchOutbox();
    expect(t.erp.postCalls).toBe(calls + 1);
    expect((await fs2.get(`/collections/${a.body.id}`)).body).toMatchObject({ status: 'posted', depositId: legacy._id.toHexString() });
    expect((await fs2.get(`/collections/${b.body.id}`)).body).toMatchObject({ status: 'received', depositId: null });
    expect((await fs2.get('/cash/me')).body.onHandPoisha).toBe(100_000); // unchanged by the migration

    // the next deposit takes the rest and the whole 2,000 BDT collection goes to the ERP
    const next = await fs2.post('/cash/deposits', { clientId: randomUUID(), amountPoisha: 100_000, destination: 'manager', depositedAt: '2026-11-15T10:00:00Z' }, { 'idempotency-key': randomUUID() });
    expect(next.status).toBe(201);
    expect(next.body.collectionCount).toBe(1);
    await dispatchOutbox();
    expect((await fs2.get(`/collections/${b.body.id}`)).body).toMatchObject({ status: 'posted', depositId: next.body.id });
    expect((await fs2.get('/cash/me')).body.onHandPoisha).toBe(0);
  });

  it('each line names the promise it was collected against, on time or not; no promise → null', async () => {
    const fs = await as(t, '01700000003');
    // the customer has several active invoices: the promise names the one the cash lines are for
    const erpPlanId = ((await fs.get('/cash/me/collections')).body.items as { erpPlanId: string }[])[0]!.erpPlanId;
    const promise = await fs.post('/promises', { clientId: randomUUID(), customerId: cust, erpPlanId, promisedDate: '2026-11-16', promisedAmountPoisha: 40_000 });
    expect(promise.status).toBe(201);
    expect((await collect(fs, 50_000, 'cash', { recordedAt: '2026-11-15T03:20:00Z' })).status).toBe(201);
    const mine = await fs.get('/cash/me/collections');
    expectConforms('GET', '/cash/me/collections', 200, mine.body);
    const newest = (mine.body.items as Item[])[0]!;
    expect(newest.amountPoisha).toBe(50_000);
    expect(newest.promise).toMatchObject({ id: promise.body.id, promisedDate: '2026-11-16', status: 'open', onTime: true });
    // a person whose customers made no promise: every line says null
    const fs2 = await as(t, '01700000004');
    const other = (await getByErpId('100247'))!.id;
    await applyAssignments([{ customerId: other, assigneeId: s.fs2.id }]);
    // the invoice is named: this customer's only plan is not active in the fixture
    const otherPlan = ((await fs2.get(`/customers/${other}`)).body.plans as { erpPlanId: string }[])[0]?.erpPlanId ?? '54001';
    const c2 = await fs2.post('/collections', { clientId: randomUUID(), customerId: other, erpPlanId: otherPlan, amountPoisha: 20_000, method: 'cash', receiptNo: 'BRL01-FS015-261115-0001', recordedAt: '2026-11-15T03:30:00Z', geo: { lat: 22.7, lng: 90.36, accuracyM: 10 } }, { 'idempotency-key': randomUUID() });
    expect(c2.status, JSON.stringify(c2.body)).toBe(201);
    const theirs = (await fs2.get('/cash/me/collections')).body.items as Item[];
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.every((i) => i.promise === null)).toBe(true);
  });
});
