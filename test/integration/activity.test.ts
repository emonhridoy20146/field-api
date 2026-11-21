import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { applyAssignments, getByErpId } from '../../src/modules/customers/index.js';
import { setSystem } from '../../src/modules/settings/index.js';
import { setFlagSystem } from '../../src/modules/flags/index.js';

// FR-ACT-001 (contract 1.28.0): what staff do, as it happens, for the office.
let t: TestApp;
let s: Seeded;
const ids: Record<string, string> = {};
const geo = { lat: 22.7106, lng: 90.3703, accuracyM: 9 };
type Line = { type: string; actor: { id: string; employeeCode: string } | null; customer: { id: string; code: string } | null; data: Record<string, unknown>; unseen: boolean; entity: string; entityId: string };

beforeAll(async () => {
  t = await createTestApp(); // Sunday 2026-11-15 10:00 Dhaka
  s = await seedBasics(t);
  await deltaSync();
  for (const e of ['100245', '100246', '100247']) ids[e] = (await getByErpId(e))!.id;
  await applyAssignments([
    { customerId: ids['100245']!, assigneeId: s.fs1.id },
    { customerId: ids['100246']!, assigneeId: s.fs1.id },
    { customerId: ids['100247']!, assigneeId: s.fs1.id },
  ]);
});
afterAll(async () => t.close());

describe('staff activity feed (FR-ACT-001)', () => {
  it('collections, visits, promises and pins appear newest first, with the person and the customer, and count as new until seen', async () => {
    const fs = await as(t, '01700000003');
    await fs.post('/attendance/events', { clientId: randomUUID(), type: 'work_in', at: '2026-11-15T03:00:00Z', geo });
    expect((await fs.post('/visits', { clientId: randomUUID(), customerId: ids['100245'], checkInAt: '2026-11-15T03:30:00Z', outcome: 'promised', geo })).status).toBe(201);
    t.clock.advance(60_000);
    expect((await fs.post('/promises', { clientId: randomUUID(), customerId: ids['100245'], promisedDate: '2026-11-18', promisedAmountPoisha: 100000 })).status).toBe(201);
    t.clock.advance(60_000);
    const col = await fs.post('/collections', { clientId: randomUUID(), customerId: ids['100246'], amountPoisha: 150000, method: 'cash', recordedAt: '2026-11-15T03:35:00Z', receiptNo: 'BRL01-FS014-261115-0001', geo }, { 'idempotency-key': randomUUID() });
    expect(col.status).toBe(201);
    t.clock.advance(60_000);
    // 100247 has no usable pin: a staff pin applies at once
    expect((await fs.post(`/customers/${ids['100247']}/location-proposals`, { clientId: randomUUID(), geo: { lat: 22.7053, lng: 90.3651, accuracyM: 12 } })).status).toBe(201);

    const bm = await as(t, '01700000002');
    const r = await bm.get('/activity');
    expect(r.status).toBe(200);
    expectConforms('GET', '/activity', 200, r.body);
    const lines = r.body.items as Line[];
    expect(lines.map((l) => l.type)).toEqual(['pin', 'collection', 'promise', 'visit']);
    expect(lines.every((l) => l.actor?.id === s.fs1.id && l.actor?.employeeCode === 'FS014' && l.unseen)).toBe(true);
    expect(lines[0]).toMatchObject({ entity: 'customer', entityId: ids['100247'], data: { applied: true }, customer: { id: ids['100247'] } });
    expect(lines[1]).toMatchObject({ entity: 'collection', entityId: col.body.id, data: { amountPoisha: 150000, method: 'cash' } });
    expect(lines[2]).toMatchObject({ data: { promisedDate: '2026-11-18' } });
    expect(lines[3]).toMatchObject({ data: { outcome: 'promised' } });
    expect(r.body).toMatchObject({ unseen: 4, seenAt: null, nextCursor: null });

    // filters and paging
    expect((await bm.get('/activity?type=collection')).body.items).toHaveLength(1);
    expect((await bm.get(`/activity?userId=${s.fs2.id}`)).body.items).toHaveLength(0);
    const p1 = await bm.get('/activity?limit=3');
    expect(p1.body.items).toHaveLength(3);
    const p2 = await bm.get(`/activity?limit=3&cursor=${encodeURIComponent(p1.body.nextCursor)}`);
    expect(p2.body.items.map((l: Line) => l.type)).toEqual(['visit']);

    // seen: the count starts again; a new line is new again
    const seen = await bm.post('/activity/seen');
    expect(seen.status).toBe(200);
    expectConforms('POST', '/activity/seen', 200, seen.body);
    expect((await bm.get('/activity')).body).toMatchObject({ unseen: 0 });
    t.clock.advance(60_000);
    await setSystem('customers.staffPinApproval', 'always', s.branchA);
    expect((await fs.post(`/customers/${ids['100246']}/location-proposals`, { clientId: randomUUID(), geo: { lat: 22.7, lng: 90.36, accuracyM: 10 } })).status).toBe(201);
    const after = await bm.get('/activity');
    expect(after.body.unseen).toBe(1);
    expect(after.body.items[0]).toMatchObject({ type: 'pin', unseen: true, data: { applied: false } });
    expect(after.body.items[1].unseen).toBe(false);
    // "seen" is per person: another admin still sees all as new
    expect((await (await as(t, '01700000001')).get('/activity')).body.unseen).toBe(5);
  });

  it('scope, permission and the flag', async () => {
    const bm = await as(t, '01700000002');
    // the manager of branch A sees nothing of branch B
    expect((await bm.get(`/activity?branchId=${s.branchB}`)).body.items).toEqual([]);
    expect((await (await as(t, '01700000006')).get('/activity')).status).toBe(200); // viewer
    expect((await (await as(t, '01700000003')).get('/activity')).status).toBe(403); // field staff
    expect((await bm.get('/activity?type=call')).status).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/activity' })).statusCode).toBe(401);
    await setFlagSystem('module.activity', false);
    expect((await (await as(t, '01700000002')).get('/activity')).status).toBe(403);
    await setFlagSystem('module.activity', true);
  });
});
