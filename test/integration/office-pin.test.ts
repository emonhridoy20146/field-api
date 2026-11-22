import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { getByErpId } from '../../src/modules/customers/index.js';

// 1.39.0 (owner request 2026-11-22, FR-CUS-022, ADR-052): a pin from the app by someone who holds
// customer.location.approve for the customer's branch applies at once; field staff still propose.
let t: TestApp;
let s: Seeded;
const ids: Record<string, string> = {};
const events: { name: string; payload: Record<string, unknown> }[] = [];
const fix = { lat: 22.7071, lng: 90.3662, accuracyM: 8 };
const pinOf = async (c: Awaited<ReturnType<typeof as>>, id: string) => (await c.get(`/customers/${id}`)).body.location;
const inboxPins = async () => {
  const bm = await as(t, '01700000002');
  const r = await bm.get('/inbox?limit=100');
  return (r.body.items as { type: string; entityId?: string }[]).filter((i) => i.type === 'location.proposal');
};

beforeAll(async () => {
  t = await createTestApp();
  s = await seedBasics(t);
  for (const n of ['customer.location.approved', 'customer.location.proposed']) t.ctx.bus.on(n, async (p) => void events.push({ name: n, payload: p }));
  await deltaSync();
  for (const e of ['100245', '100246', '200301']) ids[e] = (await getByErpId(e))!.id;
});
afterAll(async () => t.close());

describe('office pin from the app (FR-CUS-022)', () => {
  it('a branch manager moving an existing pin from the app: applied at once, direct, no inbox item', async () => {
    const bm = await as(t, '01700000002');
    expect((await pinOf(bm, ids['100245']!)).status).toBe('ok'); // has an ERP pin, so a staff move would wait
    const inboxBefore = (await inboxPins()).length;
    const body = { clientId: randomUUID(), geo: fix, note: 'House is behind the mosque' };
    const r = await bm.post(`/customers/${ids['100245']}/location-proposals`, body);
    expect(r.status).toBe(201);
    expectConforms('POST', '/customers/{id}/location-proposals', 201, r.body);
    expect(r.body).toMatchObject({ status: 'approved', direct: true });

    const loc = await pinOf(bm, ids['100245']!);
    expect(loc).toMatchObject({ status: 'overridden', source: 'overlay' });
    expect(loc.lat).toBeCloseTo(fix.lat);

    // Kept like the web's direct set: approved, direct, decided by the caller; nothing pending.
    const approved = await bm.get('/location-proposals?status=approved');
    expectConforms('GET', '/location-proposals', 200, approved.body);
    expect(approved.body.find((p: { id: string }) => p.id === r.body.id)).toMatchObject({ direct: true, autoApplied: false, method: 'gps', decider: { id: s.bm.id } });
    expect((await bm.get('/location-proposals')).body.some((p: { id: string }) => p.id === r.body.id)).toBe(false);
    expect((await inboxPins()).length).toBe(inboxBefore);
    expect(events.some((e) => e.name === 'customer.location.proposed' && e.payload.proposalId === r.body.id)).toBe(false);
    expect(events.find((e) => e.name === 'customer.location.approved' && e.payload.proposalId === r.body.id)?.payload).toMatchObject({ direct: true, fromApp: true, proposedBy: s.bm.id });

    // The app's pull shows the applied state for the caller and the branch.
    const pull = await bm.get('/sync/pull?cursor=s_0');
    expectConforms('GET', '/sync/pull', 200, pull.body);
    const ch = pull.body.changes.find((c: { entity: string; id: string }) => c.entity === 'location_proposal' && c.id === r.body.id);
    expect(ch.data).toMatchObject({ status: 'approved', direct: true, decider: { id: s.bm.id } });
    const fs = await as(t, '01700000003');
    expect((await fs.get('/sync/pull?cursor=s_0')).body.changes.some((c: { entity: string; id: string }) => c.entity === 'location_proposal' && c.id === r.body.id)).toBe(true);

    // Audited as a direct set.
    const audit = await (await as(t, '01700000001')).get(`/audit?action=customer.location.set&entityId=${ids['100245']}`);
    expect(audit.status).toBe(200);
    expect(JSON.stringify(audit.body)).toContain(r.body.id);
    expect((await (await as(t, '01700000001')).get(`/audit?action=customer.location.proposed&entityId=${ids['100245']}`)).body.items).toHaveLength(0);

    // Replay answers 200 with the same id and fate.
    const again = await bm.post(`/customers/${ids['100245']}/location-proposals`, body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: r.body.id, status: 'approved', direct: true });
  });

  it('field staff moving a pin still propose (pending, inbox item for the office)', async () => {
    const fs = await as(t, '01700000003');
    const before = (await inboxPins()).length;
    const r = await fs.post(`/customers/${ids['100245']}/location-proposals`, { clientId: randomUUID(), geo: { ...fix, lat: 22.7075 } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'pending', direct: false });
    expect((await pinOf(fs, ids['100245']!)).lat).toBeCloseTo(fix.lat); // unchanged
    expect((await inboxPins()).length).toBe(before + 1);
  });

  it('super admin applies at once; out of scope is 404 for a branch manager', async () => {
    const sa = await as(t, '01700000001');
    const r = await sa.post(`/customers/${ids['200301']}/location-proposals`, { clientId: randomUUID(), method: 'map', geo: { lat: 22.36, lng: 90.33, accuracyM: 0 }, deviceGeo: { lat: 22.361, lng: 90.331, accuracyM: 10 } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'approved', direct: true });
    const bm = await as(t, '01700000002');
    expect((await bm.post(`/customers/${ids['200301']}/location-proposals`, { clientId: randomUUID(), geo: fix })).status).toBe(404);
  });

  it('a mock phone position: gps is refused as today; a map pin stays a flagged proposal even for an approver', async () => {
    const bm = await as(t, '01700000002');
    const gps = await bm.post(`/customers/${ids['100246']}/location-proposals`, { clientId: randomUUID(), geo: { ...fix, mock: true } });
    expect(gps.status).toBe(422);
    expect(gps.body.details.rule).toBe('MOCK_LOCATION');
    const map = await bm.post(`/customers/${ids['100246']}/location-proposals`, { clientId: randomUUID(), method: 'map', geo: { ...fix, accuracyM: 0 }, deviceGeo: { ...fix, mock: true } });
    expect(map.status).toBe(201);
    expect(map.body).toMatchObject({ status: 'pending', direct: false });
    const pending = (await bm.get('/location-proposals')).body.find((p: { id: string }) => p.id === map.body.id);
    expect(pending).toMatchObject({ deviceMock: true, direct: false });
  });

  it('the permission key decides, not the role: staff granted the key apply at once; a branch deny keeps a manager proposing', async () => {
    const sa = await as(t, '01700000001');
    const grant = await sa.put(`/rbac/overrides/user/${s.fs2.id}`, { changes: [{ key: 'customer.location.approve', effect: 'allow' }], reason: 'Senior field officer' });
    expect(grant.status).toBe(200);
    const fs2 = await as(t, '01700000004');
    const r = await fs2.post(`/customers/${ids['100245']}/location-proposals`, { clientId: randomUUID(), geo: fix });
    expect(r.body).toMatchObject({ status: 'approved', direct: true });

    expect((await sa.put(`/rbac/overrides/branch/${s.branchA}`, { role: 'branch_manager', changes: [{ key: 'customer.location.approve', effect: 'deny' }], reason: 'Head office decides pins' })).status).toBe(200);
    const bm = await as(t, '01700000002');
    const p = await bm.post(`/customers/${ids['100245']}/location-proposals`, { clientId: randomUUID(), geo: { ...fix, lat: 22.708 } });
    expect(p.body).toMatchObject({ status: 'pending', direct: false });
  });
});
