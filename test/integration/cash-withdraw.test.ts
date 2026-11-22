import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { applyAssignments, getByErpId } from '../../src/modules/customers/index.js';

// Contract 1.32.0 (FR-COL-016): staff withdraw or correct their own collections until deposited; 1.35.0 (ADR-049):
// every method waits for its deposit, and a deposit is final (no delete); collected totals follow the rules.
let t: TestApp;
let s: Seeded;
let cust = '';
let seq = 0;
type Client = Awaited<ReturnType<typeof as>>;
const collect = async (c: Client, amountPoisha: number, method = 'cash', extra: Record<string, unknown> = {}) =>
  c.post(
    '/collections',
    { clientId: randomUUID(), customerId: cust, amountPoisha, method, receiptNo: `BRL01-FS014-261115-${String(++seq).padStart(4, '0')}`, recordedAt: '2026-11-15T03:00:00Z', geo: { lat: 22.7, lng: 90.36, accuracyM: 10 }, ...extra },
    { 'idempotency-key': randomUUID() },
  );
const deposit = (c: Client, amountPoisha: number) =>
  c.post('/cash/deposits', { clientId: randomUUID(), amountPoisha, destination: 'branch_cashier', depositedAt: '2026-11-15T09:00:00Z' }, { 'idempotency-key': randomUUID() });
const onHand = async (c: Client) => (await c.get('/cash/me')).body.onHandPoisha as number;
const collected = async (c: Client) => (await c.get('/reports/me/performance?month=2026-11')).body.collectedTotalPoisha as number;

beforeAll(async () => {
  t = await createTestApp();
  s = await seedBasics(t);
  await deltaSync();
  cust = (await getByErpId('100246'))!.id;
  await applyAssignments([{ customerId: cust, assigneeId: s.fs1.id }]);
});
afterAll(async () => t.close());

describe('staff correct or withdraw their own cash collection (FR-COL-016)', () => {
  let a = '';
  let b = '';

  it('edits the amount and note of an own unsent cash collection; the same values again change nothing; audited', async () => {
    const fs = await as(t, '01700000003');
    a = (await collect(fs, 200_000)).body.id;
    b = (await collect(fs, 300_000)).body.id;
    expect(await onHand(fs)).toBe(500_000);

    const r = await fs.patch(`/collections/${b}`, { amountPoisha: 350_000, note: 'corrected' });
    expect(r.status).toBe(200);
    expectConforms('PATCH', '/collections/{id}', 200, r.body);
    expect(r.body.amountPoisha).toBe(350_000);
    expect(await onHand(fs)).toBe(550_000);
    expect((await fs.patch(`/collections/${b}`, { amountPoisha: 350_000, note: 'corrected' })).status).toBe(200);
    expect((await fs.patch(`/collections/${b}`, {})).status).toBe(400);

    const sa = await as(t, '01700000001');
    const log = await sa.get(`/audit?entityId=${b}&action=collection.edited`);
    expect(log.body.items).toHaveLength(1);
    expect(log.body.items[0]).toMatchObject({ action: 'collection.edited', before: { amountPoisha: 300_000 }, after: { amountPoisha: 350_000 } });
  });

  it('a colleague cannot touch it; 1.35.0: a mobile banking collection can be corrected or withdrawn too until deposited', async () => {
    // a colleague of the same branch reads it (ADR-046) but cannot change it; another branch does not see it at all
    for (const phone of ['01700000004', '01700000005']) {
      const other = await as(t, phone);
      expect((await other.patch(`/collections/${b}`, { amountPoisha: 1 })).status).toBe(404);
      expect((await other.post(`/collections/${b}/withdraw`, {})).status).toBe(404);
    }
    const fs = await as(t, '01700000003');
    const m = await collect(fs, 90_000, 'bkash', { transactionRef: 'AB12CD34EF' });
    const e = await fs.patch(`/collections/${m.body.id}`, { amountPoisha: 80_000 });
    expect(e.status).toBe(200);
    expect(e.body).toMatchObject({ amountPoisha: 80_000, depositId: null });
    expect((await fs.post(`/collections/${m.body.id}/withdraw`, { reason: 'wrong number' })).body.status).toBe('voided');
    expect(await onHand(fs)).toBe(550_000); // bKash is never cash in hand
  });

  it('once a deposit has taken it, a collection can no longer be edited or withdrawn', async () => {
    const fs = await as(t, '01700000003');
    const before = await collected(fs);
    const w = await fs.post(`/collections/${b}/withdraw`, { reason: 'wrong customer' });
    expect(w.status).toBe(200);
    expectConforms('POST', '/collections/{id}/withdraw', 200, w.body);
    expect(w.body).toMatchObject({ status: 'voided', voided: { by: s.fs1.id, reason: 'wrong customer' } });
    // a repeat (offline retry) answers with the voided collection; the amount is gone from cash in hand and from collected
    expect((await fs.post(`/collections/${b}/withdraw`, {})).body.status).toBe('voided');
    expect(await onHand(fs)).toBe(200_000);
    expect(await collected(fs)).toBe(before - 350_000);
    expect((await fs.patch(`/collections/${b}`, { amountPoisha: 1 })).body.details.reason).toBe('NOT_EDITABLE');

    const nagad = await collect(fs, 50_000, 'nagad', { transactionRef: 'NG12CD34EF' });
    expect((await deposit(fs, 200_000)).status).toBe(201); // all of it: the cash and the Nagad collection
    for (const id of [a, nagad.body.id]) {
      expect((await fs.patch(`/collections/${id}`, { amountPoisha: 10_000 })).body.details.reason, id).toBe('COVERED_BY_DEPOSIT');
      expect((await fs.post(`/collections/${id}/withdraw`, {})).body.details.reason, id).toBe('COVERED_BY_DEPOSIT');
    }
    expect(await onHand(fs)).toBe(0);

    const sa = await as(t, '01700000001');
    expect((await sa.get(`/audit?entityId=${b}&action=collection.withdrawn`)).body.items).toHaveLength(1);
  });

  it('the offline mutations resolve the collection by its clientId', async () => {
    const fs = await as(t, '01700000003');
    const clientId = randomUUID();
    const c = await fs.post(
      '/collections',
      { clientId, customerId: cust, amountPoisha: 120_000, method: 'cash', receiptNo: `BRL01-FS014-261115-${String(++seq).padStart(4, '0')}`, recordedAt: '2026-11-15T04:00:00Z', geo: { lat: 22.7, lng: 90.36, accuracyM: 10 } },
      { 'idempotency-key': randomUUID() },
    );
    const push = (entity: string, payload: Record<string, unknown>) =>
      fs.post('/sync/push', { deviceId: 'dev-01700000003', pendingCount: 1, mutations: [{ mutationId: randomUUID(), entity, op: 'update', payload }] });
    const e = await push('collection_edit', { clientId, amountPoisha: 110_000 });
    expect(e.body.results[0]).toMatchObject({ result: 'applied', entityId: c.body.id });
    const w = await push('collection_withdraw', { clientId });
    expect(w.body.results[0]).toMatchObject({ result: 'applied', status: 'voided' });
  });
});

describe('a deposit is final (1.35.0, ADR-049): FR-CASH-009 delete is retired', () => {
  it('nobody deletes a deposit; the money stays handed in and its collections stay locked', async () => {
    const fs = await as(t, '01700000003');
    const bm = await as(t, '01700000002');
    const c = await collect(fs, 400_000);
    expect(c.status).toBe(201);
    const dep = (await deposit(fs, 400_000)).body;
    expect(dep.status).toBe('submitted');
    expect(await onHand(fs)).toBe(0);
    expect((await fs.post(`/cash/deposits/${dep.id}/delete`, { reason: 'entered twice by mistake' })).status).toBe(403);
    expect((await (await as(t, '01700000004')).post(`/cash/deposits/${dep.id}/delete`, { reason: 'not my deposit' })).status).toBe(403);
    const r = await bm.post(`/cash/deposits/${dep.id}/delete`, { reason: 'entered twice by mistake' });
    expect(r.status).toBe(409);
    expect(r.body.details.reason).toBe('DEPOSIT_FINAL');
    expect(await onHand(fs)).toBe(0);
    expect((await fs.patch(`/collections/${c.body.id}`, { amountPoisha: 390_000 })).body.details.reason).toBe('COVERED_BY_DEPOSIT');
    expect((await bm.get(`/cash/deposits/${dep.id}/collections`)).body.items.map((i: { collectionId: string }) => i.collectionId)).toEqual([c.body.id]);
  });
});
