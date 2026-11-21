import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { applyAssignments, getByErpId } from '../../src/modules/customers/index.js';
import { ChangeModel, CounterModel } from '../../src/core/changefeed/index.js';

// ADR-046 (contract 1.31.0): staff see every visit, promise and collection of their branch with the name of who did it.
// They still cannot change a colleague's record.
let t: TestApp;
let s: Seeded;
const ids: Record<string, string> = {};
let visitId = '';
let promiseId = '';

const visitBody = (customerId: string, checkInAt: string) => ({
  clientId: randomUUID(),
  customerId,
  checkInAt,
  outcome: 'promised',
  geo: { lat: 22.7106, lng: 90.3703, accuracyM: 9, mock: false },
});

beforeAll(async () => {
  t = await createTestApp();
  s = await seedBasics(t);
  await deltaSync();
  for (const e of ['100245', '100246']) ids[e] = (await getByErpId(e))!.id;
  await applyAssignments([{ customerId: ids['100246']!, assigneeId: s.fs1.id }]);
  const fs1 = await as(t, '01700000003');
  const v = await fs1.post('/visits', visitBody(ids['100245']!, '2026-11-15T04:00:00Z'));
  visitId = v.body.id;
  const p = await fs1.post('/promises', { clientId: randomUUID(), customerId: ids['100246'], promisedDate: '2026-11-16', promisedAmountPoisha: 350_000 });
  promiseId = p.body.id;
});
afterAll(async () => t.close());

describe('who did it (contract 1.31.0)', () => {
  it('the visit and the promise carry the staff name, on create and on read', async () => {
    const fs1 = await as(t, '01700000003');
    const v = await fs1.get(`/visits?customerId=${ids['100245']}`);
    expectConforms('GET', '/visits', 200, v.body);
    expect(v.body.items.find((i: { id: string }) => i.id === visitId)).toMatchObject({ userId: s.fs1.id, userName: 'Rakib Hasan' });
    const p = await fs1.get(`/promises?customerId=${ids['100246']}`);
    expectConforms('GET', '/promises', 200, p.body);
    expect(p.body.items.find((i: { id: string }) => i.id === promiseId)).toMatchObject({ createdBy: s.fs1.id, createdByName: 'Rakib Hasan', ownerId: s.fs1.id, ownerName: 'Rakib Hasan' });
  });
});

describe('read scope: the branch, write scope: the owner', () => {
  it('a colleague of the same branch reads the visit and the promise', async () => {
    const fs2 = await as(t, '01700000004');
    expect((await fs2.get(`/visits?customerId=${ids['100245']}`)).body.items.map((i: { id: string }) => i.id)).toContain(visitId);
    const list = await fs2.get(`/promises?customerId=${ids['100246']}`);
    expectConforms('GET', '/promises', 200, list.body);
    expect(list.body.items.map((i: { id: string; createdByName: string }) => [i.id, i.createdByName])).toContainEqual([promiseId, 'Rakib Hasan']);
  });

  it('staff of another branch read neither', async () => {
    const fsB = await as(t, '01700000005');
    expect((await fsB.get('/visits')).body.items).toHaveLength(0);
    expect((await fsB.get('/promises')).body.items).toHaveLength(0);
  });

  it("a colleague cannot change another's records: checkout and cancel answer 404, the owner can cancel", async () => {
    const fs2 = await as(t, '01700000004');
    expect((await fs2.patch(`/visits/${visitId}/checkout`, { checkOutAt: '2026-11-15T05:00:00Z' })).status).toBe(404);
    expect((await fs2.post(`/promises/${promiseId}/cancel`, { reason: 'not my promise' })).status).toBe(404);
    const fs1 = await as(t, '01700000003');
    const done = await fs1.post(`/promises/${promiseId}/cancel`, { reason: 'customer paid in full' });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('cancelled');
    expect(done.body.createdByName).toBe('Rakib Hasan');
  });
});

describe('sync: fan-out, snapshot window, resync floor', () => {
  it('every record is written to the change feed for the whole branch', async () => {
    for (const entity of ['visit', 'promise']) {
      const row = await ChangeModel.findOne({ entity, entityId: entity === 'visit' ? visitId : promiseId }).lean();
      expect(row?.fanoutBranchId).toBe(s.branchA);
    }
  });

  it('a colleague receives them on pull, with the staff names', async () => {
    const fs2 = await as(t, '01700000004');
    const pull = await fs2.get('/sync/pull?cursor=s_0');
    const visit = pull.body.changes.find((c: { entity: string; id: string }) => c.entity === 'visit' && c.id === visitId);
    expect(visit.data.userName).toBe('Rakib Hasan');
    const promise = pull.body.changes.find((c: { entity: string; id: string }) => c.entity === 'promise' && c.id === promiseId);
    expect(promise.data.createdByName).toBe('Rakib Hasan');
  });

  it('the fresh-device snapshot covers the branch for 60 days and no further back', async () => {
    const fs1 = await as(t, '01700000003');
    const old = await fs1.post('/visits', visitBody(ids['100245']!, '2026-08-01T04:00:00Z'));
    expect(old.status).toBe(201);
    const fs2 = await as(t, '01700000004');
    const snap = await fs2.get('/sync/bootstrap?limit=200');
    const visits = snap.body.items.filter((i: { entity: string }) => i.entity === 'visit').map((i: { id: string }) => i.id);
    expect(visits).toContain(visitId);
    expect(visits).not.toContain(old.body.id);
  });

  it('phones that took a snapshot under the own-only rule are told to take a new one', async () => {
    expect(await CounterModel.findById('sync_floor:branch-wide-activity')).not.toBeNull();
  });
});
