import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { applyAssignments, getByErpId } from '../../src/modules/customers/index.js';
import { dispatchOutbox } from '../../src/core/events/outbox.js';
import { setSystem } from '../../src/modules/settings/index.js';
import { verifyChain } from '../../src/modules/audit/index.js';

let t: TestApp;
let s: Seeded;
const ids: Record<string, string> = {};
let seq = 0;
const receipt = () => `BRL01-FS014-261115-${String(++seq).padStart(4, '0')}`;
const body = (over: Record<string, unknown> = {}) => ({
  clientId: randomUUID(),
  customerId: ids['100246'],
  amountPoisha: 350000,
  method: 'cash',
  receiptNo: receipt(),
  recordedAt: '2026-11-15T03:55:00Z',
  deviceTime: '2026-11-15T03:55:05Z',
  geo: { lat: 22.7053, lng: 90.3651, accuracyM: 12 },
  ...over,
});
const post = async (c: Awaited<ReturnType<typeof as>>, b: Record<string, unknown>, key = randomUUID()) => ({ key, res: await c.post('/collections', b, { 'idempotency-key': key }) });

beforeAll(async () => {
  t = await createTestApp();
  s = await seedBasics(t);
  await deltaSync();
  for (const e of ['100245', '100246', '100247', '100248', '200301']) ids[e] = (await getByErpId(e))!.id;
  await applyAssignments([
    { customerId: ids['100245']!, assigneeId: s.fs1.id },
    { customerId: ids['100246']!, assigneeId: s.fs1.id },
    { customerId: ids['100248']!, assigneeId: s.fs1.id },
  ]);
});
afterAll(async () => t.close());

describe('record + post (FR-COL-001..005, 008)', () => {
  let id = '';
  let key = '';
  let first: Record<string, unknown> = {};
  it('records a cash collection (201), then the worker posts it to ERP', async () => {
    const fs = await as(t, '01700000003');
    first = body();
    const r = await post(fs, first);
    key = r.key;
    expect(r.res.status).toBe(201);
    expectConforms('POST', '/collections', 201, r.res.body);
    expect(r.res.body.status).toBe('received');
    expect(r.res.body.erpPlanId).toBe('55100'); // only active plan auto-chosen
    expect(r.res.body.flags).toEqual([]);
    id = r.res.body.id;
    await dispatchOutbox();
    const g = await fs.get(`/collections/${id}`);
    expect(g.body.status).toBe('posted');
    expect(g.body.erpReceiptNo).toMatch(/^R-/);
    // customer balance refreshed from ERP
    expect((await fs.get(`/customers/${ids['100246']}`)).body.totalOutstandingPoisha).toBe(2100000);
  });

  it('same key + same payload replays (200); different payload → 409; same receipt with new key → 409', async () => {
    const fs = await as(t, '01700000003');
    const again = await fs.post('/collections', first, { 'idempotency-key': key });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(id);
    expect(again.body.replayed).toBe(true);
    const diff = await fs.post('/collections', { ...first, amountPoisha: 1 }, { 'idempotency-key': key });
    expect(diff.status).toBe(409);
    expect(diff.body.code).toBe('IDEMPOTENCY_MISMATCH');
    const dupReceipt = await fs.post('/collections', { ...first, clientId: randomUUID() }, { 'idempotency-key': randomUUID() });
    expect(dupReceipt.status).toBe(409);
    expect(dupReceipt.body.code).toBe('DUPLICATE_RECEIPT_NO');
    expect(t.erp.postCalls).toBe(1);
  });

  it('validates: header, txn ref for mobile, receipt prefix, plan choice when several active', async () => {
    const fs = await as(t, '01700000003');
    expect((await fs.post('/collections', body())).status).toBe(400); // no Idempotency-Key
    const noRef = await post(fs, body({ method: 'bkash' }));
    expect(noRef.res.status).toBe(400);
    expect(noRef.res.body.details.fields[0].path).toBe('transactionRef');
    expect((await post(fs, body({ receiptNo: 'BRL01-FS015-261115-0001' }))).res.status).toBe(400);
    expect((await post(fs, body({ customerId: ids['100248'] }))).res.body.details.fields[0].path).toBe('erpPlanId');
    expect((await post(fs, body({ customerId: ids['200301'] }))).res.status).toBe(404);
  });

  it('flags far_from_pin, mock, late sync and duplicate txn ref but never blocks', async () => {
    const fs = await as(t, '01700000003');
    await post(fs, body({ method: 'bkash', transactionRef: 'ab12cd34ef', amountPoisha: 1000 }));
    const r = await post(fs, body({ customerId: ids['100245'], method: 'bkash', transactionRef: 'AB12CD34EF', amountPoisha: 1000, recordedAt: '2026-11-14T10:00:00Z', deviceTime: '2026-11-14T10:00:00Z', geo: { lat: 22.75, lng: 90.40, accuracyM: 8, mock: true } }));
    expect(r.res.status).toBe(201);
    expect(r.res.body.flags.sort()).toEqual(['duplicate_txn_ref', 'far_from_pin', 'late_sync', 'mock_location']);
  });
});

describe('no GPS fix (contract 1.2.0)', () => {
  it('accepts geo: null and flags no_location', async () => {
    const fs = await as(t, '01700000003');
    const r = await post(fs, body({ geo: null, geoUnavailableReason: 'location_off', amountPoisha: 500 }));
    expect(r.res.status).toBe(201);
    expectConforms('POST', '/collections', 201, r.res.body);
    expect(r.res.body.flags).toContain('no_location');
    expect(r.res.body.distanceToPinM).toBeNull();
  });
});

describe('ERP failures (07-test-plan §3)', () => {
  it('timeout after store: second attempt finds the payment by key, no double post', async () => {
    const fs = await as(t, '01700000003');
    await dispatchOutbox(); // drain earlier jobs so the injected failure hits ours
    const r = await post(fs, body({ amountPoisha: 100000 }));
    t.erp.failNext('timeout_after_store');
    await dispatchOutbox();
    expect((await fs.get(`/collections/${r.res.body.id}`)).body.status).toBe('posting');
    t.clock.advance(31_000);
    await dispatchOutbox();
    expect((await fs.get(`/collections/${r.res.body.id}`)).body.status).toBe('posted');
  });

  it('plan settled → conflict; manager resolves post_to_plan with the request key', async () => {
    const fs = await as(t, '01700000003');
    const r = await post(fs, body({ customerId: ids['100248'], erpPlanId: '54500', amountPoisha: 5000 }));
    t.erp.officePayment('100248', '54500', 1); // settled in office meanwhile
    await dispatchOutbox();
    const c = await fs.get(`/collections/${r.res.body.id}`);
    expect(c.body.status).toBe('conflict');
    expect(['PLAN_SETTLED', 'AMOUNT_EXCEEDS_OUTSTANDING']).toContain(c.body.conflict.code);
    const bm = await as(t, '01700000002');
    const list = await bm.get('/collections/conflicts');
    expect(list.body.items.map((x: { id: string }) => x.id)).toContain(r.res.body.id);
    expect((await fs.post(`/collections/${r.res.body.id}/resolve`, { action: 'void', reason: 'nope nope' }, { 'idempotency-key': randomUUID() })).status).toBe(403);
    const rk = randomUUID();
    const res = await bm.post(`/collections/${r.res.body.id}/resolve`, { action: 'post_to_plan', erpPlanId: '55300', reason: 'Customer agreed: apply to AC plan' }, { 'idempotency-key': rk });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('received');
    // replay of the same resolve request is harmless
    expect((await bm.post(`/collections/${r.res.body.id}/resolve`, { action: 'post_to_plan', erpPlanId: '55300', reason: 'Customer agreed: apply to AC plan' }, { 'idempotency-key': rk })).status).toBe(200);
    await dispatchOutbox();
    const done = await fs.get(`/collections/${r.res.body.id}`);
    expect(done.body.status).toBe('resolved_posted');
    expect(done.body.erpPlanId).toBe('55300');
  });

  it('void before posting cancels the ERP post', async () => {
    const fs = await as(t, '01700000003');
    const r = await post(fs, body({ amountPoisha: 2000 }));
    const bm = await as(t, '01700000002');
    const v = await bm.post(`/collections/${r.res.body.id}/void`, { reason: 'Entered twice by mistake' });
    expect(v.status).toBe(200);
    expect(v.body.status).toBe('voided');
    const calls = t.erp.postCalls;
    await dispatchOutbox();
    expect(t.erp.postCalls).toBe(calls);
    expect((await bm.post(`/collections/${r.res.body.id}/void`, { reason: 'again again' })).status).toBe(409);
  });

  it('record-only mode defers posting; requeue after it is switched off', async () => {
    await setSystem('erp.recordOnly', true);
    const fs = await as(t, '01700000003');
    const r = await post(fs, body({ amountPoisha: 3000 }));
    await dispatchOutbox();
    expect((await fs.get(`/collections/${r.res.body.id}`)).body.status).toBe('received');
    await setSystem('erp.recordOnly', false);
    t.clock.advance(11 * 60_000);
    const { requeueStuck } = await import('../../src/modules/collections/service.js');
    expect(await requeueStuck()).toBeGreaterThanOrEqual(1);
    await dispatchOutbox();
    expect((await (await as(t, '01700000003')).get(`/collections/${r.res.body.id}`)).body.status).toBe('posted');
  });

  it('office reversal of a field payment is reflected after sync', async () => {
    const bm = await as(t, '01700000002');
    const list = await bm.get('/collections?status=posted');
    const target = list.body.items[0];
    const full = await bm.get(`/collections/${target.id}`);
    const cust = (await t.erp.getCustomer('100246'))!;
    const pay = cust.recentPayments.find((p) => p.receiptNo === full.body.erpReceiptNo)!;
    t.erp.reversePayment(pay.erpPaymentId);
    await deltaSync();
    expect((await bm.get(`/collections/${target.id}`)).body.erpReversed).toBe(true);
  });
});

describe('list & scope (FR-COL-010)', () => {
  it('field staff see own only; managers see branch with totals by method', async () => {
    const fs2 = await as(t, '01700000004');
    expect((await fs2.get('/collections')).body.items).toHaveLength(0);
    const bm = await as(t, '01700000002');
    const r = await bm.get('/collections?from=2026-11-14&to=2026-11-30');
    expect(r.status).toBe(200);
    expectConforms('GET', '/collections', 200, r.body);
    expect(r.body.totals.cash).toBeGreaterThan(0);
    expect(r.body.totals.bkash).toBe(2000);
    const fsB = await as(t, '01700000005');
    expect((await fsB.get(`/collections/${r.body.items[0].id}`)).status).toBe(404);
  });

  it('customer detail shows pending field money; timeline shows field collections', async () => {
    const fs = await as(t, '01700000003');
    const d = await fs.get(`/customers/${ids['100246']}`);
    expect(Array.isArray(d.body.pendingCollections)).toBe(true);
    const tl = await fs.get(`/customers/${ids['100246']}/timeline`);
    expect(tl.body.items.some((i: { kind: string }) => i.kind === 'field_collection')).toBe(true);
  });

  it('receipt blocks never overlap', async () => {
    const fs = await as(t, '01700000003');
    const a = await fs.post('/receipts/blocks', { deviceId: 'dev-01700000003', businessDate: '2026-11-17', size: 100 });
    const b = await fs.post('/receipts/blocks', { deviceId: 'dev-other', businessDate: '2026-11-17', size: 100 });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ prefix: 'BRL01-FS014', from: 1, to: 100 });
    expect(b.body).toMatchObject({ from: 101, to: 200 });
  });

  it('audit chain is intact after money actions', async () => {
    expect((await verifyChain()).ok).toBe(true);
  });
});
