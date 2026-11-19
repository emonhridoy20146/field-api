import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { applyAssignments, getByErpId } from '../../src/modules/customers/index.js';
import { ChangeModel, CounterModel, raiseResyncFloor } from '../../src/core/changefeed/index.js';

/**
 * FR-CUS-015 / ADR-038 (contract 1.19.0): field staff see every customer of their branches, assigned or not, and a
 * staff member can work in several branches. The assigned-only rule (setting = assigned) is covered by the older
 * customers / sync / assignments / fieldwork suites.
 */
let t: TestApp;
let s: Seeded;
const ids: Record<string, string> = {};
const erpIds = (items: { erpCustomerId: string }[]) => items.map((x) => x.erpCustomerId).sort();
type Change = { entity: string; op: string; id: string; data?: { assignee?: { id: string } } };

async function pullAll(phone: string, cursor: string): Promise<{ changes: Change[]; next: string }> {
  const c = await as(t, phone);
  const out: Change[] = [];
  let cur = cursor;
  for (;;) {
    const r = await c.get(`/sync/pull?cursor=${cur}&limit=200`);
    expect(r.status).toBe(200);
    out.push(...r.body.changes);
    cur = r.body.nextCursor;
    if (!r.body.hasMore) break;
  }
  return { changes: out.filter((x) => x.entity === 'customer'), next: cur };
}

beforeAll(async () => {
  t = await createTestApp();
  s = await seedBasics(t);
  await deltaSync();
  for (const e of ['100245', '100246', '100247', '100248', '200301']) ids[e] = (await getByErpId(e))!.id;
  // fs1 owns 100245, fs2 owns 100246, 100247 + 100248 are unassigned; fsB owns 200301 (branch B)
  await applyAssignments([
    { customerId: ids['100245']!, assigneeId: s.fs1.id },
    { customerId: ids['100246']!, assigneeId: s.fs2.id },
    { customerId: ids['200301']!, assigneeId: s.fsB.id },
  ]);
});
afterAll(async () => t.close());

describe('branch-wide visibility for field staff (FR-CUS-015)', () => {
  it('lists every customer of the branch, assigned or not, and says which branch each is in', async () => {
    const fs = await as(t, '01700000003');
    const res = await fs.get('/customers');
    expect(res.status).toBe(200);
    expectConforms('GET', '/customers', 200, res.body);
    expect(erpIds(res.body.items)).toEqual(['100245', '100246', '100247', '100248']);
    const row = res.body.items.find((x: { erpCustomerId: string }) => x.erpCustomerId === '100246');
    expect(row.branch).toMatchObject({ id: s.branchA, code: 'BRL01' });
    expect(row.branch.name.en).toBeTruthy();
    expect(row.assignee).toMatchObject({ id: s.fs2.id });
    // "assigned to me" still narrows to the own work list
    expect(erpIds((await fs.get('/customers?assignedTo=me')).body.items)).toEqual(['100245']);
  });

  it('keeps other branches out of scope (404) and lets staff work on any customer of their branch', async () => {
    const fs = await as(t, '01700000003');
    expect((await fs.get(`/customers/${ids['200301']}`)).status).toBe(404);
    const d = await fs.get(`/customers/${ids['100248']}`);
    expect(d.status).toBe(200);
    expectConforms('GET', '/customers/{id}', 200, d.body);
    const note = await fs.post(`/customers/${ids['100248']}/notes`, { clientId: randomUUID(), text: 'Met the neighbour, will come back' });
    expect(note.status).toBe(201);
  });

  it('bootstrap carries the whole branch', async () => {
    const fs = await as(t, '01700000003');
    const r = await fs.get('/sync/bootstrap?limit=50');
    expect(r.status).toBe(200);
    expectConforms('GET', '/sync/bootstrap', 200, r.body);
    const got = r.body.items.filter((i: { entity: string }) => i.entity === 'customer').map((i: { data: { erpCustomerId: string } }) => i.data);
    expect(erpIds(got)).toEqual(['100245', '100246', '100247', '100248']);
    expect(r.body.settings['customers.staffVisibility']).toBe('branch');
  });

  it("a change to a colleague's customer reaches every device of the branch; reassigning never deletes it there", async () => {
    const head = (await (await as(t, '01700000003')).get('/sync/bootstrap?limit=50')).body.pullCursor as string;
    await applyAssignments([{ customerId: ids['100246']!, assigneeId: s.fs1.id }]);
    const fs1 = await pullAll('01700000003', head);
    const c1 = fs1.changes.find((x) => x.id === ids['100246']);
    expect(c1?.op).toBe('upsert');
    expect(c1?.data?.assignee?.id).toBe(s.fs1.id);
    // the old assignee keeps it (still in the branch), now showing the new owner
    const fs2 = await pullAll('01700000004', head);
    expect(fs2.changes.find((x) => x.id === ids['100246'])).toMatchObject({ op: 'upsert', data: { assignee: { id: s.fs1.id } } });
    // branch B's staff never see branch A's change
    const fsB = await pullAll('01700000005', head);
    expect(fsB.changes.find((x) => x.id === ids['100246'])).toBeUndefined();
    expect(await ChangeModel.countDocuments({ fanoutBranchId: s.branchA })).toBeGreaterThan(0);
  });
});

describe('staff in several branches (FR-USER-001, FR-CUS-015)', () => {
  it('adding a branch sends its customers to the device; removing it drops them', async () => {
    const sa = await as(t, '01700000001');
    const head = (await (await as(t, '01700000003')).get('/sync/bootstrap?limit=50')).body.pullCursor as string;
    const up = await sa.patch(`/users/${s.fs1.id}`, { branchIds: [s.branchA, s.branchB], reason: 'covers Patuakhali too' });
    expect(up.status).toBe(200);
    expect(up.body.branchIds).toEqual([s.branchA, s.branchB]);

    const fs = await as(t, '01700000003');
    const list = await fs.get('/customers');
    expect(erpIds(list.body.items)).toEqual(['100245', '100246', '100247', '100248', '200301']);
    expect(list.body.items.find((x: { erpCustomerId: string }) => x.erpCustomerId === '200301').branch.code).toBe('PTK01');
    expect(erpIds((await fs.get(`/customers?branchId=${s.branchB}`)).body.items)).toEqual(['200301']);
    const added = await pullAll('01700000003', head);
    expect(added.changes.find((x) => x.id === ids['200301'])?.op).toBe('upsert');

    await sa.patch(`/users/${s.fs1.id}`, { branchIds: [s.branchA], reason: 'back to Barishal only' });
    const removed = await pullAll('01700000003', added.next);
    expect(removed.changes.find((x) => x.id === ids['200301'])?.op).toBe('delete');
    expect((await fs.get(`/customers/${ids['200301']}`)).status).toBe(404);
  });

  it('a branch manager cannot give staff a branch outside their own', async () => {
    const bm = await as(t, '01700000002');
    const r = await bm.patch(`/users/${s.fs2.id}`, { branchIds: [s.branchA, s.branchB], reason: 'try' });
    expect(r.status).toBe(403);
  });
});

describe('setting customers.staffVisibility = assigned (per branch)', () => {
  it('switching a branch to assigned narrows the list and drops the others from devices; switching back restores them', async () => {
    const sa = await as(t, '01700000001');
    const fsPhone = '01700000004'; // fs2: owns nothing now (100246 moved to fs1)
    const head = (await (await as(t, fsPhone)).get('/sync/bootstrap?limit=50')).body.pullCursor as string;
    const r = await sa.patch('/settings', { branchId: s.branchA, changes: { 'customers.staffVisibility': 'assigned' }, reason: 'assigned only for now' });
    expect(r.status).toBe(200);
    const fs = await as(t, fsPhone);
    expect((await fs.get('/customers')).body.items).toHaveLength(0);
    expect((await fs.get(`/customers/${ids['100248']}`)).status).toBe(404);
    const dropped = await pullAll(fsPhone, head);
    expect(dropped.changes.filter((x) => x.op === 'delete').map((x) => x.id).sort()).toEqual(
      ['100245', '100246', '100247', '100248'].map((e) => ids[e]!).sort(),
    );
    // the assignee still has their own customers
    expect(erpIds((await (await as(t, '01700000003')).get('/customers')).body.items)).toEqual(['100245', '100246']);

    await sa.patch('/settings', { branchId: s.branchA, changes: { 'customers.staffVisibility': 'branch' }, reason: 'whole branch again' });
    const back = await pullAll(fsPhone, dropped.next);
    expect(back.changes.filter((x) => x.op === 'upsert')).toHaveLength(4);
    expect((await fs.get('/customers')).body.items).toHaveLength(4);
  });
});

describe('phones that took their snapshot before branch-wide visibility (1.20.1, ADR-038 addendum)', () => {
  it('a cursor from before the resync floor is refused once; the fresh snapshot carries the whole branch', async () => {
    // the test database was empty when the app booted: nothing to reset
    expect((await CounterModel.findById('sync_floor:customers-branch-wide').lean())?.value).toBe(0);
    const fs = await as(t, '01700000004');
    const old = (await fs.get('/sync/bootstrap?limit=50')).body.pullCursor as string;
    expect((await fs.get(`/sync/pull?cursor=${old}`)).status).toBe(200);

    // first boot of 1.20.1 on a database with history
    await CounterModel.deleteOne({ _id: 'sync_floor:customers-branch-wide' });
    const floor = await raiseResyncFloor('customers-branch-wide');
    expect(floor).toBeGreaterThan(Number(old.slice(2)));
    expect(await raiseResyncFloor('customers-branch-wide')).toBe(floor); // raised once, later boots keep it

    const r = await fs.get(`/sync/pull?cursor=${old}`);
    expect(r.status).toBe(410);
    expect(r.body.code).toBe('CURSOR_EXPIRED');
    expectConforms('GET', '/sync/pull', 410, r.body);
    const snap = await fs.get('/sync/bootstrap?limit=50');
    expect(Number((snap.body.pullCursor as string).slice(2))).toBeGreaterThanOrEqual(floor);
    const got = snap.body.items.filter((i: { entity: string }) => i.entity === 'customer').map((i: { data: { erpCustomerId: string } }) => i.data);
    expect(erpIds(got)).toEqual(['100245', '100246', '100247', '100248']);
    expect((await fs.get(`/sync/pull?cursor=${snap.body.pullCursor}`)).status).toBe(200);
  });
});
