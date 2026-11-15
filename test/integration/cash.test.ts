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
