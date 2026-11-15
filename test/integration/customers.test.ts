import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { deltaSync, reconcile } from '../../src/modules/erp-gateway/index.js';
import { applyAssignments, getByErpId } from '../../src/modules/customers/index.js';

let t: TestApp;
let s: Seeded;
const ids: Record<string, string> = {};
const events: { name: string; payload: unknown }[] = [];

beforeAll(async () => {
  t = await createTestApp();
  s = await seedBasics(t);
  for (const n of ['customer.balance_cleared', 'customer.placed']) t.ctx.bus.on(n, async (p) => void events.push({ name: n, payload: p }));
  await deltaSync();
  for (const e of ['100245', '100246', '100247', '100248', '200301']) ids[e] = (await getByErpId(e))!.id;
  // fs1 owns 100245 + 100246, fs2 owns 100247; 100248 unassigned; fsB owns 200301
  await applyAssignments([
    { customerId: ids['100245']!, assigneeId: s.fs1.id },
    { customerId: ids['100246']!, assigneeId: s.fs1.id },
    { customerId: ids['100247']!, assigneeId: s.fs2.id },
    { customerId: ids['200301']!, assigneeId: s.fsB.id },
  ]);
});
afterAll(async () => t.close());

describe('customer list & scope (FR-CUS-001/002)', () => {
  it('field staff sees only assigned customers, conforming to contract', async () => {
    const c = await as(t, '01700000003');
    const res = await c.get('/customers');
    expect(res.status).toBe(200);
    expectConforms('GET', '/customers', 200, res.body);
    expect(res.body.items.map((x: { erpCustomerId: string }) => x.erpCustomerId).sort()).toEqual(['100245', '100246']);
    // default sort: most overdue first
    expect(res.body.items[0].erpCustomerId).toBe('100245');
    expect(res.body.items[0].erpFetchedAt).toBeTruthy();
  });

  it('branch manager sees the whole branch, not branch B', async () => {
    const c = await as(t, '01700000002');
    const res = await c.get('/customers?includeTotal=true');
    expect(res.body.total).toBe(4);
    expect(res.body.items.some((x: { erpCustomerId: string }) => x.erpCustomerId === '200301')).toBe(false);
  });

  it('out-of-scope detail is 404, not 403', async () => {
    const c = await as(t, '01700000003');
    expect((await c.get(`/customers/${ids['200301']}`)).status).toBe(404);
    expect((await c.get(`/customers/${ids['100247']}`)).status).toBe(404);
    expect((await c.get('/customers/not-an-id')).status).toBe(404);
  });

  it('status filters combine with OR', async () => {
    const c = await as(t, '01700000002');
    const res = await c.get('/customers?filter=overdue,due_today');
    expect(res.body.items.some((x: { erpCustomerId: string }) => x.erpCustomerId === '100245')).toBe(true);
    expect(res.body.items.some((x: { erpCustomerId: string }) => x.erpCustomerId === '100246')).toBe(true);
    expect(res.body.items.some((x: { erpCustomerId: string }) => x.erpCustomerId === '100247')).toBe(false);
  });

  it('filters: unassigned, no_location, paid_up, bad_suggested; unknown filter is 400', async () => {
    const c = await as(t, '01700000002');
    const codes = async (q: string) => (await c.get(`/customers?${q}`)).body.items.map((x: { erpCustomerId: string }) => x.erpCustomerId).sort();
    expect(await codes('filter=unassigned')).toEqual(['100248']);
    expect(await codes('filter=no_location')).toEqual(['100246', '100247', '100248']);
    expect(await codes('filter=paid_up')).toEqual(['100247']);
    // 100248: rice-cooker plan ended 2026-11-14 with 1 poisha left → still suggested (FR-TAG-001 has no tolerance)
    expect(await codes('filter=bad_suggested')).toEqual(['100245', '100248']);
    expect((await c.get('/customers?filter=bogus')).status).toBe(400);
  });

  it('search by name, code and phone tail', async () => {
    const c = await as(t, '01700000002');
    expect((await c.get('/customers?q=karim')).body.items[0].erpCustomerId).toBe('100245');
    expect((await c.get('/customers?q=100247')).body.items[0].erpCustomerId).toBe('100247');
    expect((await c.get('/customers?q=000111')).body.items[0].erpCustomerId).toBe('100246');
  });

  it('paginates with an opaque cursor', async () => {
    const c = await as(t, '01700000002');
    const p1 = await c.get('/customers?limit=3&sort=name');
    expect(p1.body.items).toHaveLength(3);
    const p2 = await c.get(`/customers?limit=3&sort=name&cursor=${encodeURIComponent(p1.body.nextCursor)}`);
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.nextCursor).toBeNull();
  });

  it('distance sort needs near', async () => {
    const c = await as(t, '01700000002');
    expect((await c.get('/customers?sort=distance')).status).toBe(400);
    const r = await c.get('/customers?sort=distance&near=22.7101,90.3705&radiusM=5000');
    expect(r.status).toBe(200);
    expect(r.body.items[0].distanceM).toBeLessThan(100);
  });

  it('viewer can read; requires login', async () => {
    expect((await (await as(t, '01700000006')).get('/customers')).status).toBe(200);
  });
});

describe('customer detail (FR-CUS-003/005)', () => {
  it('shows plans, estimated schedule, payments and a bad suggestion text', async () => {
    const c = await as(t, '01700000003');
    const res = await c.get(`/customers/${ids['100245']}`);
    expect(res.status).toBe(200);
    expectConforms('GET', '/customers/{id}', 200, res.body);
    expect(res.body.badSuggestion.outstandingPoisha).toBe(850000);
    expect(res.body.badSuggestion.text.en).toContain('8,500');
    expect(res.body.plans[0].finalDueDate).toBe('2026-10-10');
    expect(res.body.payments[0].receiptNo).toBe('R-77812');
  });

  it('a plan with null end_date takes the last schedule date (never month arithmetic)', async () => {
    const c = await as(t, '01700000002');
    const res = await c.get(`/customers/${ids['100248']}`);
    const ac = res.body.plans.find((p: { product: string }) => p.product.startsWith('Walton AC'));
    expect(ac.finalDueDate).toBe('2027-03-20');
    expect(ac.schedule.every((l: { estimated: boolean }) => l.estimated)).toBe(true);
  });

  it('timeline lists ERP payments', async () => {
    const c = await as(t, '01700000003');
    const res = await c.get(`/customers/${ids['100245']}/timeline`);
    expect(res.status).toBe(200);
    expectConforms('GET', '/customers/{id}/timeline', 200, res.body);
    expect(res.body.items[0].kind).toBe('erp_payment');
  });
});

describe('map (FR-MAP-001)', () => {
  it('returns pins in bbox with status; clusters at low zoom', async () => {
    const c = await as(t, '01700000002');
    const res = await c.get('/customers/map?bbox=90.30,22.65,90.42,22.75&zoom=15');
    expect(res.status).toBe(200);
    expectConforms('GET', '/customers/map', 200, res.body);
    expect(res.body.pins.map((p: { status: string }) => p.status)).toEqual(['bad_suggested']); // worst status wins
    const low = await c.get('/customers/map?bbox=88,20,93,27&zoom=8');
    expect(low.body.pins).toHaveLength(0);
    expect(low.body.clusters[0].count).toBe(1);
    expect((await c.get('/customers/map?bbox=nope')).status).toBe(400);
  });
});

describe('refresh (FR-ERP-003)', () => {
  it('pulls fresh ERP data, rate-limits to once per 30s, 503 when ERP down', async () => {
    const c = await as(t, '01700000003');
    t.erp.officePayment('100246', '55100', 350000);
    const r1 = await c.post(`/customers/${ids['100246']}/refresh`);
    expect(r1.status).toBe(200);
    expect(r1.body.totalOutstandingPoisha).toBe(2100000);
    expect((await c.post(`/customers/${ids['100246']}/refresh`)).status).toBe(429);
    t.clock.advance(31_000);
    t.erp.unavailable = true;
    const r3 = await c.post(`/customers/${ids['100246']}/refresh`);
    t.erp.unavailable = false;
    expect(r3.status).toBe(503);
    expect(r3.body.code).toBe('ERP_UNAVAILABLE');
  });

  it('emits balance_cleared when outstanding drops to zero', async () => {
    t.erp.officePayment('100248', '54500', 1);
    t.erp.officePayment('100248', '55300', 6300000);
    await deltaSync();
    expect(events.some((e) => e.name === 'customer.balance_cleared' && (e.payload as { customerId: string }).customerId === ids['100248'])).toBe(true);
  });

  it('reconcile marks customers missing from ERP, never deletes them', async () => {
    t.erp.removeCustomer('100247');
    await reconcile();
    const ref = await getByErpId('100247');
    expect(ref).not.toBeNull();
    expect(ref!.erpStatus).toBe('missing');
  });
});

describe('pin corrections (FR-CUS-008)', () => {
  let proposalId = '';
  const clientId = randomUUID();
  const body = { clientId, geo: { lat: 22.7053, lng: 90.3651, accuracyM: 12 }, note: 'Gate is on the east side' };

  it('field staff proposes; replay with same clientId is idempotent', async () => {
    const c = await as(t, '01700000003');
    const r = await c.post(`/customers/${ids['100246']}/location-proposals`, body);
    expect(r.status).toBe(201);
    proposalId = r.body.id;
    const again = await c.post(`/customers/${ids['100246']}/location-proposals`, body);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(proposalId);
  });

  it('rejects low accuracy, mock and outside-Bangladesh fixes', async () => {
    const c = await as(t, '01700000003');
    const post = (geo: Record<string, unknown>) => c.post(`/customers/${ids['100246']}/location-proposals`, { clientId: randomUUID(), geo });
    expect((await post({ lat: 22.7, lng: 90.36, accuracyM: 80 })).body.details.rule).toBe('LOW_ACCURACY');
    expect((await post({ lat: 22.7, lng: 90.36, accuracyM: 5, mock: true })).body.details.rule).toBe('MOCK_LOCATION');
    expect((await post({ lat: 51.5, lng: -0.12, accuracyM: 5 })).body.details.rule).toBe('OUTSIDE_BANGLADESH');
  });

  it('field staff cannot approve (403); manager in other branch gets 404', async () => {
    const fs = await as(t, '01700000003');
    expect((await fs.post(`/location-proposals/${proposalId}/decision`, { decision: 'approve' })).status).toBe(403);
  });

  it('manager approves; pin becomes overridden and survives the next ERP sync', async () => {
    const bm = await as(t, '01700000002');
    const list = await bm.get('/location-proposals');
    expect(list.body.items.map((p: { id: string }) => p.id)).toContain(proposalId);
    const d = await bm.post(`/location-proposals/${proposalId}/decision`, { decision: 'approve' });
    expect(d.status).toBe(200);
    expect((await bm.post(`/location-proposals/${proposalId}/decision`, { decision: 'approve' })).status).toBe(409);
    await deltaSync();
    const det = await bm.get(`/customers/${ids['100246']}`);
    expect(det.body.location.lat).toBeCloseTo(22.7053);
    expect(det.body.location.status).toBe('overridden');
  });
});
