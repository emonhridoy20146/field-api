import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { applyAssignments, getByErpId } from '../../src/modules/customers/index.js';

// Contract 1.32.0 (FR-COL-016, FR-CASH-009): staff withdraw or correct their own cash collections until deposited;
// an admin deletes a deposit; the depositor is told; the audit log keeps both; collected totals follow the rules.
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

  it('a colleague cannot touch it; a non-cash collection cannot be edited or withdrawn', async () => {
    // a colleague of the same branch reads it (ADR-046) but cannot change it; another branch does not see it at all
    for (const phone of ['01700000004', '01700000005']) {
      const other = await as(t, phone);
      expect((await other.patch(`/collections/${b}`, { amountPoisha: 1 })).status).toBe(404);
      expect((await other.post(`/collections/${b}/withdraw`, {})).status).toBe(404);
    }
    const fs = await as(t, '01700000003');
    const m = await collect(fs, 90_000, 'bkash', { transactionRef: 'AB12CD34EF' });
    expect((await fs.patch(`/collections/${m.body.id}`, { amountPoisha: 80_000 })).body.details.reason).toBe('NOT_CASH');
    expect((await fs.post(`/collections/${m.body.id}/withdraw`, {})).body.details.reason).toBe('NOT_CASH');
  });

  it('once a deposit covers it, the collection can no longer be edited or withdrawn; the uncovered one still can', async () => {
    const fs = await as(t, '01700000003');
    expect((await deposit(fs, 200_000)).status).toBe(201); // pays off the oldest collection (a) first
    expect((await fs.patch(`/collections/${a}`, { amountPoisha: 100_000 })).body.details.reason).toBe('COVERED_BY_DEPOSIT');
    expect((await fs.post(`/collections/${a}/withdraw`, {})).body.details.reason).toBe('COVERED_BY_DEPOSIT');

    const before = await collected(fs);
    const w = await fs.post(`/collections/${b}/withdraw`, { reason: 'wrong customer' });
    expect(w.status).toBe(200);
    expectConforms('POST', '/collections/{id}/withdraw', 200, w.body);
    expect(w.body).toMatchObject({ status: 'voided', voided: { by: s.fs1.id, reason: 'wrong customer' } });
    // a repeat (offline retry) answers with the voided collection; the amount is gone from cash in hand and from collected
    expect((await fs.post(`/collections/${b}/withdraw`, {})).body.status).toBe('voided');
    expect(await onHand(fs)).toBe(0);
    expect(await collected(fs)).toBe(before - 350_000);
    expect((await fs.patch(`/collections/${b}`, { amountPoisha: 1 })).body.details.reason).toBe('NOT_EDITABLE');

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

describe('an admin deletes a deposit (FR-CASH-009)', () => {
  it('staff cannot; a manager deletes a verified deposit with a reason → cash back on hand, depositor told, audited, row kept', async () => {
    const fs = await as(t, '01700000003');
    const bm = await as(t, '01700000002');
    const sa = await as(t, '01700000001');
    const c = await collect(fs, 400_000);
    expect(c.status).toBe(201);
    const dep = (await deposit(fs, 400_000)).body;
    const pending = await bm.get('/cash/deposits?status=pending');
    expect(pending.body.items.find((d: { id: string }) => d.id === dep.id)).toBeTruthy();
    expect((await sa.post(`/cash/deposits/${dep.id}/verify`)).body.status).toBe('verified');
    expect(await onHand(fs)).toBe(0);
    const collectedAfterDeposit = await collected(fs);
    expect(collectedAfterDeposit).toBeGreaterThanOrEqual(400_000); // performance keeps what was collected

    expect((await fs.post(`/cash/deposits/${dep.id}/delete`, { reason: 'entered twice by mistake' })).status).toBe(403);
    expect((await bm.post(`/cash/deposits/${dep.id}/delete`, {})).status).toBe(400);
    const r = await bm.post(`/cash/deposits/${dep.id}/delete`, { reason: 'entered twice by mistake' });
    expect(r.status).toBe(200);
    expectConforms('POST', '/cash/deposits/{id}/delete', 200, r.body);
    expect(r.body).toMatchObject({ status: 'deleted', deletedBy: s.bm.id, deleteReason: 'entered twice by mistake' });
    expect(await onHand(fs)).toBe(400_000);
    expect(await collected(fs)).toBe(collectedAfterDeposit);

    // the row is kept and listed; it can be deleted once only; the collections it covered are empty
    expect((await bm.get('/cash/deposits?status=deleted')).body.items.map((d: { id: string }) => d.id)).toContain(dep.id);
    expect((await bm.post(`/cash/deposits/${dep.id}/delete`, { reason: 'again again' })).body.details.reason).toBe('NOT_DELETABLE');
    expect((await bm.get(`/cash/deposits/${dep.id}/collections`)).body.items).toHaveLength(0);

    const note = (await fs.get('/notifications')).body.items.find((n: { type: string }) => n.type === 'cash.deposit.deleted');
    expect(note).toBeTruthy();
    expect((await sa.get(`/audit?entityId=${dep.id}&action=cash.deposit.deleted`)).body.items[0]).toMatchObject({ reason: 'entered twice by mistake', after: { status: 'deleted' } });
    // the money is in hand again, so the collection can be corrected again
    expect((await fs.patch(`/collections/${c.body.id}`, { amountPoisha: 390_000 })).status).toBe(200);
  });

  it('a colleague cannot delete it (403)', async () => {
    const fs = await as(t, '01700000003');
    const dep = (await deposit(fs, 1)).body;
    expect((await (await as(t, '01700000004')).post(`/cash/deposits/${dep.id}/delete`, { reason: 'not my deposit' })).status).toBe(403);
  });
});
