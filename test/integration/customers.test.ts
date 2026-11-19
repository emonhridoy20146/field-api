import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { deltaSync, reconcile } from '../../src/modules/erp-gateway/index.js';
import { applyAssignments, getByErpId } from '../../src/modules/customers/index.js';
import { setSystem } from '../../src/modules/settings/index.js';
import { AssignmentModel } from '../../src/modules/assignments/models/assignment.model.js';

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
  const owners: [string, string, string][] = [
    ['100245', s.fs1.id, s.branchA],
    ['100246', s.fs1.id, s.branchA],
    ['100247', s.fs2.id, s.branchA],
    ['200301', s.fsB.id, s.branchB],
  ];
  await applyAssignments(owners.map(([e, u]) => ({ customerId: ids[e]!, assigneeId: u })));
  // The assignment records behind them (made long ago), so a recompute after a pin change keeps the owner (1.11.0).
  await AssignmentModel.insertMany(owners.map(([e, u, b]) => ({ branchId: b, userId: u, type: 'customer', customerId: ids[e]!, effectiveFrom: new Date('2026-01-01T00:00:00Z'), source: 'manual' })));
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
    expect(res.body.items[0].overduePoisha).toBe(850000);
    const rina = res.body.items.find((x: { erpCustomerId: string }) => x.erpCustomerId === '100246');
    expect(rina.installmentPoisha).toBe(350000); // line due today
    expect(rina.areaName).toBeNull();
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
    // 1.13.0: what the plan is in the ERP, and the ERP's directions and risk (ADR-033)
    expect(res.body.plans[0]).toMatchObject({ kind: 'installment', invoiceNo: 'INV-55021', frequency: 'monthly', items: [{ name: 'Walton Fridge', model: 'WFC-3D8', qty: 1 }], guarantor: { name: 'Abdul Malek', phone: '01911000000' } });
    expect(res.body.plans[0].schedule[5]).toMatchObject({ lateFeePoisha: 0, rolled: false });
    expect(res.body).toMatchObject({ directions: 'Blue gate next to the mosque', erpRisk: { grade: 'C', level: 'Medium' } });
    expect(res.body.payments[0]).toMatchObject({ receiptNo: 'PAY-20260912-09921', erpPlanId: '55021', methodLabel: 'Cash-03', collectorName: 'Rakib Hasan' });
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
  // The manager-approval path for a customer without a pin needs the "approve every pin" policy (1.11.0, ADR-031);
  // the default (`when_missing`) is covered by the map pin tests below.
  beforeAll(async () => setSystem('customers.staffPinApproval', 'always'));
  afterAll(async () => setSystem('customers.staffPinApproval', 'when_missing'));

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
    expectConforms('GET', '/location-proposals', 200, list.body);
    expect(list.body.map((p: { id: string }) => p.id)).toContain(proposalId);
    const d = await bm.post(`/location-proposals/${proposalId}/decision`, { decision: 'approve' });
    expect(d.status).toBe(200);
    expect((await bm.post(`/location-proposals/${proposalId}/decision`, { decision: 'approve' })).status).toBe(409);
    await deltaSync();
    const det = await bm.get(`/customers/${ids['100246']}`);
    expect(det.body.location.lat).toBeCloseTo(22.7053);
    expect(det.body.location.status).toBe('overridden');
  });

  it('the proposer learns the decision: own list and /sync/pull carry status and the rejection reason', async () => {
    const fs = await as(t, '01700000003');
    const second = await fs.post(`/customers/${ids['100246']}/location-proposals`, { clientId: randomUUID(), geo: { lat: 22.7061, lng: 90.3655, accuracyM: 9 } });
    const bm = await as(t, '01700000002');
    expect((await bm.post(`/location-proposals/${second.body.id}/decision`, { decision: 'reject' })).status).toBe(422); // a reason is required
    expect((await bm.post(`/location-proposals/${second.body.id}/decision`, { decision: 'reject', reason: 'Pin is on the main road, not the house' })).status).toBe(200);

    const mine = await fs.get('/location-proposals/mine');
    expect(mine.status).toBe(200);
    expectConforms('GET', '/location-proposals/mine', 200, mine.body);
    expect(mine.body.map((p: { status: string }) => p.status)).toEqual(['rejected', 'approved']); // newest first
    expect(mine.body[0]).toMatchObject({ id: second.body.id, customerId: ids['100246'], decisionReason: 'Pin is on the main road, not the house', lat: 22.7061 });
    expect(mine.body[0].decidedAt).not.toBeNull();
    expect(mine.body[1]).toMatchObject({ id: proposalId, clientId, decisionReason: null });
    expect((await fs.get('/location-proposals/mine?status=rejected')).body).toHaveLength(1);
    expect((await fs.get('/location-proposals/mine?status=lost')).status).toBe(400);

    const pull = await fs.get('/sync/pull?cursor=s_0');
    expectConforms('GET', '/sync/pull', 200, pull.body);
    const changes = pull.body.changes.filter((c: { entity: string }) => c.entity === 'location_proposal');
    expect(changes.map((c: { id: string; op: string; data: { status: string } }) => [c.id, c.op, c.data.status]).sort()).toEqual([[proposalId, 'upsert', 'approved'], [second.body.id, 'upsert', 'rejected']].sort());
    expect(changes.find((c: { id: string }) => c.id === second.body.id).data.decisionReason).toBe('Pin is on the main road, not the house');

    // Nobody else sees them: not another staff member, not the manager's own list, not their sync feed.
    const other = await as(t, '01700000004');
    expect((await other.get('/location-proposals/mine')).body).toEqual([]);
    expect((await other.get('/sync/pull?cursor=s_0')).body.changes.filter((c: { entity: string }) => c.entity === 'location_proposal')).toEqual([]);
    expect((await bm.get('/location-proposals/mine')).body).toEqual([]);
    expect((await (await as(t, '01700000006')).get('/location-proposals/mine')).status).toBe(403); // viewer cannot propose
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/location-proposals/mine' })).statusCode).toBe(401);
  });
});

describe('map pins (FR-CUS-011, contract 1.11.0)', () => {
  // 100247 (fs2) and 100248 (unassigned) have no usable pin; 100246 got one above.
  const near = { lat: 22.7112, lng: 90.3712 };
  const phone = { lat: 22.7130, lng: 90.3712, accuracyM: 14 }; // ≈ 200 m north of the picked point

  it('a staff map pin for a customer without a pin applies at once (default when_missing)', async () => {
    const fs2 = await as(t, '01700000004');
    const before = events.length;
    const r = await fs2.post(`/customers/${ids['100247']}/location-proposals`, { clientId: randomUUID(), method: 'map', geo: { ...near, accuracyM: 0 }, deviceGeo: phone });
    expect(r.status).toBe(201);
    expectConforms('POST', '/customers/{id}/location-proposals', 201, r.body);
    expect(r.body.status).toBe('approved');
    const det = await fs2.get(`/customers/${ids['100247']}`);
    expect(det.body.location).toMatchObject({ status: 'overridden', source: 'overlay' });
    expect(det.body.location.lat).toBeCloseTo(near.lat);
    expect(det.body.branchId).toBe(s.branchA);
    // areas are recomputed for the newly placed customer
    expect(events.slice(before).some((e) => e.name === 'customer.placed' && (e.payload as { customerId: string }).customerId === ids['100247'])).toBe(true);

    const bm = await as(t, '01700000002');
    expect((await bm.get('/location-proposals')).body.some((p: { id: string }) => p.id === r.body.id)).toBe(false); // nothing to approve
    const approved = await bm.get('/location-proposals?status=approved');
    expectConforms('GET', '/location-proposals', 200, approved.body);
    const item = approved.body.find((p: { id: string }) => p.id === r.body.id);
    expect(item).toMatchObject({ method: 'map', autoApplied: true, direct: false, deviceMock: false, decider: null });
    expect(item.deviceDistanceM).toBeGreaterThan(150);
    expect(item.deviceDistanceM).toBeLessThan(250);
    expect(item.decidedAt).not.toBeNull();

    const mine = await fs2.get('/location-proposals/mine');
    expectConforms('GET', '/location-proposals/mine', 200, mine.body);
    expect(mine.body[0]).toMatchObject({ id: r.body.id, status: 'approved', method: 'map', autoApplied: true });
    const pull = await fs2.get('/sync/pull?cursor=s_0');
    expect(pull.body.changes.some((c: { entity: string; id: string }) => c.entity === 'customer' && c.id === ids['100247'])).toBe(true);

    const tl = await fs2.get(`/customers/${ids['100247']}/timeline`);
    expect(tl.body.items.find((x: { kind: string }) => x.kind === 'location_correction')).toMatchObject({ summary: { en: 'Map pin added from the field' }, actor: { name: 'Sumon Mia' } });
  });

  it('moving an existing pin waits for a manager, also from the map; a map pin is not held to GPS accuracy', async () => {
    const fs2 = await as(t, '01700000004');
    const r = await fs2.post(`/customers/${ids['100247']}/location-proposals`, { clientId: randomUUID(), method: 'map', geo: { lat: 22.7116, lng: 90.3716, accuracyM: 0, mock: true }, deviceGeo: null });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('pending');
    const det = await fs2.get(`/customers/${ids['100247']}`);
    expect(det.body.location.lat).toBeCloseTo(near.lat); // unchanged until approved
    // gps keeps its rules
    expect((await fs2.post(`/customers/${ids['100247']}/location-proposals`, { clientId: randomUUID(), method: 'gps', geo: { ...near, accuracyM: 80 } })).body.details.rule).toBe('LOW_ACCURACY');
    expect((await fs2.post(`/customers/${ids['100247']}/location-proposals`, { clientId: randomUUID(), method: 'map', geo: { lat: 51.5, lng: -0.12, accuracyM: 0 } })).body.details.rule).toBe('OUTSIDE_BANGLADESH');
    expect((await fs2.post(`/customers/${ids['100247']}/location-proposals`, { clientId: randomUUID(), method: 'drawn', geo: { ...near, accuracyM: 0 } })).status).toBe(400);
  });

  it('a mock phone position never applies at once; the always policy keeps every pin for a manager', async () => {
    const bm = await as(t, '01700000002');
    const mock = await bm.post(`/customers/${ids['100248']}/location-proposals`, { clientId: randomUUID(), method: 'map', geo: { ...near, accuracyM: 0 }, deviceGeo: { ...phone, mock: true } });
    expect(mock.body.status).toBe('pending');
    expect((await bm.get('/location-proposals')).body.find((p: { id: string }) => p.id === mock.body.id)).toMatchObject({ deviceMock: true, autoApplied: false });
    await setSystem('customers.staffPinApproval', 'always', s.branchA);
    const held = await bm.post(`/customers/${ids['100248']}/location-proposals`, { clientId: randomUUID(), method: 'map', geo: { ...near, accuracyM: 0 } });
    expect(held.body.status).toBe('pending');
    await setSystem('customers.staffPinApproval', 'when_missing', s.branchA);
    expect((await bm.get(`/customers/${ids['100248']}`)).body.location.status).toBe('missing');
  });

  it('a manager sets a pin directly: idempotent, audited, in the pin history and timeline, recomputes polygon areas', async () => {
    const bm = await as(t, '01700000002');
    // A polygon area around the spot, held by fs1: placing 100248 inside it must give it to fs1.
    const square = (c: { lat: number; lng: number }, d: number) => ({ type: 'Polygon', coordinates: [[[c.lng - d, c.lat - d], [c.lng + d, c.lat - d], [c.lng + d, c.lat + d], [c.lng - d, c.lat + d], [c.lng - d, c.lat - d]]] });
    const spot = { lat: 22.7301, lng: 90.3801 };
    const area = await bm.post('/areas', { branchId: s.branchA, name: { bn: 'উত্তর পাড়া', en: 'North para' }, code: 'NORTH-PARA', kind: 'polygon', polygon: square(spot, 0.002) });
    expect(area.status).toBe(201);
    expect((await bm.post('/assignments', { userId: s.fs1.id, type: 'area', areaId: area.body.id })).status).toBe(201);
    expect((await bm.get(`/customers/${ids['100248']}`)).body.assignee).toBeUndefined();

    const clientId = randomUUID();
    const r = await bm.post(`/customers/${ids['100248']}/location`, { clientId, ...spot, note: 'From the shop sign board' });
    expect(r.status).toBe(201);
    expectConforms('POST', '/customers/{id}/location', 201, r.body);
    expect(r.body).toMatchObject({ status: 'approved', location: { status: 'overridden', source: 'overlay' } });
    expect(r.body.location.lat).toBeCloseTo(spot.lat);
    const again = await bm.post(`/customers/${ids['100248']}/location`, { clientId, ...spot });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(r.body.id);

    const det = await bm.get(`/customers/${ids['100248']}`);
    expect(det.body.assignee?.id).toBe(s.fs1.id);
    expect(det.body.areaName).toEqual({ bn: 'উত্তর পাড়া', en: 'North para' });

    const approved = (await bm.get('/location-proposals?status=approved')).body.find((p: { id: string }) => p.id === r.body.id);
    expect(approved).toMatchObject({ direct: true, autoApplied: false, method: 'map', decider: { id: s.bm.id, name: 'Manager A' } });
    expect(approved.accuracyM).toBeUndefined();
    // the staff proposal from the test above is still waiting for a decision
    expect((await bm.get('/location-proposals')).body.some((p: { customer: { id: string } }) => p.customer.id === ids['100248'])).toBe(true);
    expect((await bm.get('/location-proposals/mine')).body.some((p: { id: string }) => p.id === r.body.id)).toBe(false);

    const tl = await bm.get(`/customers/${ids['100248']}/timeline`);
    expect(tl.body.items.find((x: { kind: string }) => x.kind === 'location_correction')).toMatchObject({ summary: { en: 'Map pin set by a manager' }, actor: { id: s.bm.id } });
    const audit = await (await as(t, '01700000001')).get(`/audit?entity=customer&entityId=${ids['100248']}`);
    expect(JSON.stringify(audit.body)).toContain('customer.location.set');
  });

  it('set pin: 403 for staff and viewer, 404 out of scope, 422 outside Bangladesh, 409 for a reused clientId, 400 without a clientId', async () => {
    const body = { clientId: randomUUID(), lat: 22.7, lng: 90.37 };
    expect((await (await as(t, '01700000003')).post(`/customers/${ids['100245']}/location`, body)).status).toBe(403);
    expect((await (await as(t, '01700000006')).post(`/customers/${ids['100245']}/location`, body)).status).toBe(403);
    const bm = await as(t, '01700000002');
    expect((await bm.post(`/customers/${ids['200301']}/location`, body)).status).toBe(404);
    const out = await bm.post(`/customers/${ids['100245']}/location`, { ...body, lat: 51.5, lng: -0.12 });
    expect(out.status).toBe(422);
    expect(out.body.details.rule).toBe('OUTSIDE_BANGLADESH');
    expect((await bm.post(`/customers/${ids['100245']}/location`, { lat: 22.7, lng: 90.37 })).status).toBe(400);
    const first = await bm.post(`/customers/${ids['100245']}/location`, body);
    expect(first.status).toBe(201);
    expect((await bm.post(`/customers/${ids['100246']}/location`, body)).status).toBe(409);
    expect((await t.app.inject({ method: 'POST', url: `/api/v1/customers/${ids['100245']}/location`, payload: body })).statusCode).toBe(401);
  });

  it('delete pin (1.17.0): ERP pin removed, idempotent, audited, stays removed after an ERP resync, a new pin brings it back', async () => {
    const sa = await as(t, '01700000001');
    const before = events.length;
    expect((await sa.get(`/customers/${ids['200301']}`)).body.location.status).toBe('ok'); // the ERP knows this pin
    const r = await sa.delete(`/customers/${ids['200301']}/location`);
    expect(r.status).toBe(200);
    expectConforms('DELETE', '/customers/{id}/location', 200, r.body);
    expect(r.body).toMatchObject({ removed: true, location: { lat: null, lng: null, status: 'missing', source: 'overlay' } });
    expect(events.slice(before).some((e) => e.name === 'customer.placed' && (e.payload as { customerId: string }).customerId === ids['200301'])).toBe(true);
    // the assignee's phone hears about it
    const pull = await (await as(t, '01700000005')).get('/sync/pull?cursor=s_0');
    expect(pull.body.changes.some((c: { entity: string; id: string }) => c.entity === 'customer' && c.id === ids['200301'])).toBe(true);
    // not on the map, in the "no location" list
    expect((await sa.get(`/customers?filter=no_location&branchId=${s.branchB}`)).body.items.some((x: { erpCustomerId: string }) => x.erpCustomerId === '200301')).toBe(true);

    // idempotent: nothing left to remove
    const again = await sa.delete(`/customers/${ids['200301']}/location`);
    expect(again.status).toBe(200);
    expect(again.body.removed).toBe(false);

    // the nightly full reconcile and a delta sync must not bring the ERP coordinates back
    await reconcile();
    await deltaSync();
    const det = await sa.get(`/customers/${ids['200301']}`);
    expect(det.body.location).toMatchObject({ lat: null, lng: null, status: 'missing' });

    const audit = await sa.get(`/audit?entity=customer&entityId=${ids['200301']}`);
    expect(JSON.stringify(audit.body)).toContain('customer.location.cleared');

    // a new pin replaces the deletion
    const set = await sa.post(`/customers/${ids['200301']}/location`, { clientId: randomUUID(), lat: 22.6501, lng: 90.3601 });
    expect(set.status).toBe(201);
    expect((await sa.get(`/customers/${ids['200301']}`)).body.location).toMatchObject({ status: 'overridden', source: 'overlay' });
  });

  it('delete pin: 403 for staff and viewer, 404 out of scope or unknown, 401 without a token', async () => {
    expect((await (await as(t, '01700000003')).delete(`/customers/${ids['100245']}/location`)).status).toBe(403);
    expect((await (await as(t, '01700000006')).delete(`/customers/${ids['100245']}/location`)).status).toBe(403);
    const bm = await as(t, '01700000002');
    expect((await bm.delete(`/customers/${ids['200301']}/location`)).status).toBe(404); // branch B
    expect((await bm.delete('/customers/not-an-id/location')).status).toBe(404);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/v1/customers/${ids['100245']}/location` })).statusCode).toBe(401);
    // a branch manager deletes a pin in their own branch
    expect((await bm.delete(`/customers/${ids['100245']}/location`)).body.removed).toBe(true);
  });

  it('the customer timeline lists direct assignments (FR-ASG-004)', async () => {
    const bm = await as(t, '01700000002');
    const a = await bm.post('/assignments', { userId: s.fs2.id, type: 'customer', customerId: ids['100248'], reason: 'Lives next to Sumon' });
    expect(a.status).toBe(201);
    expect((await bm.get(`/customers/${ids['100248']}`)).body.assignee.id).toBe(s.fs2.id); // direct beats the area
    expect((await bm.delete(`/assignments/${a.body.id}`)).status).toBeLessThan(300);
    expect((await bm.get(`/customers/${ids['100248']}`)).body.assignee.id).toBe(s.fs1.id); // back to the area holder
    const tl = await bm.get(`/customers/${ids['100248']}/timeline`);
    expectConforms('GET', '/customers/{id}/timeline', 200, tl.body);
    const kinds = tl.body.items.filter((x: { kind: string }) => x.kind === 'assignment').map((x: { summary: { en: string } }) => x.summary.en);
    expect(kinds).toEqual(['Assignment to Sumon Mia ended', 'Assigned to Sumon Mia']);
  });
});
