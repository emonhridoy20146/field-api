import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setSystem } from '../../src/modules/settings/index.js';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { applyAssignments, getByErpId } from '../../src/modules/customers/index.js';
import { ChangeModel } from '../../src/core/changefeed/index.js';
import { setFlagSystem } from '../../src/modules/flags/index.js';

let t: TestApp;
let s: Seeded;
const ids: Record<string, string> = {};
const geo = { lat: 22.7106, lng: 90.3703, accuracyM: 9 };
const mut = (entity: string, payload: Record<string, unknown>, mutationId = randomUUID()) => ({ mutationId, entity, op: 'create', payload });
let pullCursor = '';
let batch: ReturnType<typeof mut>[] = [];
const visitClientId = randomUUID();

beforeAll(async () => {
  t = await createTestApp();
  s = await seedBasics(t);
  // These cases cover the assigned-only rule (customers.staffVisibility = assigned); branch-wide scope: staff-visibility.test.ts.
  await setSystem('customers.staffVisibility', 'assigned');
  await deltaSync();
  for (const e of ['100245', '100246', '100248']) ids[e] = (await getByErpId(e))!.id;
  await applyAssignments([
    { customerId: ids['100245']!, assigneeId: s.fs1.id },
    { customerId: ids['100246']!, assigneeId: s.fs1.id },
    { customerId: ids['100248']!, assigneeId: s.fs2.id },
  ]);
});
afterAll(async () => t.close());

describe('bootstrap (FR-SYNC-006)', () => {
  it('pages the whole scope and ends with a pull cursor', async () => {
    const fs = await as(t, '01700000003');
    const p1 = await fs.get('/sync/bootstrap?limit=1');
    expect(p1.status).toBe(200);
    expectConforms('GET', '/sync/bootstrap', 200, p1.body);
    expect(p1.body.items).toHaveLength(1);
    expect(p1.body.nextCursor).toBeTruthy();
    expect(p1.body.pullCursor).toBeUndefined();
    const p2 = await fs.get(`/sync/bootstrap?limit=50&cursor=${encodeURIComponent(p1.body.nextCursor)}`);
    expect(p2.body.nextCursor).toBeNull();
    expect(p2.body.pullCursor).toMatch(/^s_\d+$/);
    const got = [...p1.body.items, ...p2.body.items].filter((i: { entity: string }) => i.entity === 'customer').map((i: { id: string }) => i.id).sort();
    expect(got).toEqual([ids['100245'], ids['100246']].sort());
    expect(p2.body.permissions.keys).toContain('collection.record');
    expect(p2.body.flags['module.sync']).toBe(true);
    expect(p2.body.settings['cash.limitMode']).toBe('warn');
    pullCursor = p2.body.pullCursor;
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/sync/bootstrap' })).statusCode).toBe(401);
  });
});

describe('push (FR-SYNC-002)', () => {
  it('applies each item on its own; bad items are rejected without blocking the rest', async () => {
    const fs = await as(t, '01700000003');
    batch = [
      mut('attendance_event', { clientId: randomUUID(), type: 'work_in', at: '2026-11-15T03:00:00Z', geo }),
      mut('visit', { clientId: visitClientId, customerId: ids['100245'], checkInAt: '2026-11-15T03:30:00Z', outcome: 'partial_paid', geo }),
      mut('collection', { clientId: randomUUID(), customerId: ids['100246'], amountPoisha: 150000, method: 'cash', recordedAt: '2026-11-15T03:35:00Z', receiptNo: 'BRL01-FS014-261115-0001', geo }),
      mut('note', { clientId: randomUUID(), customerId: ids['100245'], text: 'Will pay the rest on Tuesday' }),
      mut('promise', { clientId: randomUUID(), customerId: ids['100245'], promisedDate: '2026-11-17', promisedAmountPoisha: 350000 }),
      mut('contact_attempt', { clientId: randomUUID(), customerId: ids['100245'], channel: 'call', at: '2026-11-15T03:20:00Z', outcome: 'connected' }),
      mut('visit_checkout', { visitClientId, checkOutAt: '2026-11-15T03:45:00Z' }),
      mut('visit', { clientId: randomUUID(), customerId: 'a'.repeat(24), checkInAt: '2026-11-15T03:30:00Z', outcome: 'not_home', geo }), // unknown customer
      mut('note', { customerId: ids['100245'] }), // invalid payload
      mut('spaceship', {}),
    ];
    const r = await fs.post('/sync/push', { deviceId: 'dev-01700000003', lastPullCursor: pullCursor, pendingCount: 3, mutations: batch });
    expect(r.status).toBe(200);
    expectConforms('POST', '/sync/push', 200, r.body);
    const res = r.body.results as { mutationId: string; result: string; entityId?: string; status?: string; error?: { code: string } }[];
    expect(res.map((x) => x.mutationId)).toEqual(batch.map((b) => b.mutationId));
    expect(res.slice(0, 7).map((x) => x.result)).toEqual(Array(7).fill('applied'));
    expect(res[2]!.status).toBe('received');
    expect(res[7]!.error!.code).toBe('NOT_FOUND');
    expect(res[8]!.error!.code).toBe('VALIDATION_FAILED');
    expect(res[9]!.result).toBe('rejected');
    expect(r.body.serverTime).toBe(t.clock.now().toISOString());
  });

  it('replays the same batch without duplicating anything; a changed payload under the same id is refused', async () => {
    const fs = await as(t, '01700000003');
    const r = await fs.post('/sync/push', { deviceId: 'dev-01700000003', mutations: batch.slice(0, 7) });
    expect(r.body.results.map((x: { result: string }) => x.result)).toEqual(Array(7).fill('replayed'));
    const v = await fs.get(`/visits?customerId=${ids['100245']}`);
    expect(v.body.items).toHaveLength(1);
    expect(v.body.items[0].checkOutAt).toBe('2026-11-15T03:45:00.000Z');
    expect((await fs.get('/collections')).body.items).toHaveLength(1);
    const changed = await fs.post('/sync/push', { deviceId: 'dev-01700000003', mutations: [{ ...batch[3]!, payload: { ...batch[3]!.payload, text: 'different' } }] });
    expect(changed.body.results[0].error.code).toBe('IDEMPOTENCY_MISMATCH');
  });

  it('checks device, permission and module flag per item', async () => {
    const fs = await as(t, '01700000003');
    expect((await fs.post('/sync/push', { deviceId: 'someone-else', mutations: [] })).status).toBe(400);
    expect((await fs.post('/sync/push', { deviceId: 'dev-01700000003', mutations: Array(101).fill(batch[0]) })).status).toBe(400);
    const vw = await as(t, '01700000006');
    const denied = await vw.post('/sync/push', { deviceId: 'dev-01700000006', mutations: [mut('note', { clientId: randomUUID(), customerId: ids['100245'], text: 'x' })] });
    expect(denied.body.results[0].error.code).toBe('FORBIDDEN');
    await setFlagSystem('module.notes', false);
    const off = await fs.post('/sync/push', { deviceId: 'dev-01700000003', mutations: [mut('note', { clientId: randomUUID(), customerId: ids['100245'], text: 'x' })] });
    expect(off.body.results[0].error.code).toBe('FEATURE_DISABLED');
    await setFlagSystem('module.notes', true);
  });
});

describe('pull (FR-SYNC-001/004)', () => {
  it('returns own changes since the cursor with fresh data and the envelope', async () => {
    const fs = await as(t, '01700000003');
    const r = await fs.get(`/sync/pull?cursor=${pullCursor}`);
    expect(r.status).toBe(200);
    expectConforms('GET', '/sync/pull', 200, r.body);
    const entities = new Set(r.body.changes.map((c: { entity: string }) => c.entity));
    for (const e of ['visit', 'collection', 'note', 'promise', 'attendance_day', 'contact_attempt']) expect(entities).toContain(e);
    const visit = r.body.changes.find((c: { entity: string }) => c.entity === 'visit');
    expect(visit.op).toBe('upsert');
    expect(visit.data.checkOutAt).toBe('2026-11-15T03:45:00.000Z');
    expect(new Set(r.body.changes.map((c: { entity: string; id: string }) => `${c.entity}:${c.id}`)).size).toBe(r.body.changes.length); // deduped
    expect(r.body.hasMore).toBe(false);
    expect(r.body.cash.onHandPoisha).toBe(150000);
    expect(r.body.permissions.version).toBeGreaterThanOrEqual(0);
    const again = await fs.get(`/sync/pull?cursor=${r.body.nextCursor}`);
    expect(again.body.changes).toEqual([]);
    // paging
    const small = await fs.get(`/sync/pull?cursor=${pullCursor}&limit=2`);
    expect(small.body.hasMore).toBe(true);
    expect(small.body.changes.length).toBeLessThanOrEqual(2);
  });

  it("does not leak another staff member's changes; losing scope becomes a tombstone", async () => {
    const fs2 = await as(t, '01700000004');
    const r = await fs2.get('/sync/pull?cursor=s_0');
    // ADR-046: a colleague of the same branch receives the visits and collections (each with the staff name)...
    expect(r.body.changes.some((c: { entity: string; data?: { userName?: string } }) => c.entity === 'visit' && !!c.data?.userName)).toBe(true);
    expect(r.body.changes.some((c: { entity: string; data?: { collector?: { name: string } } }) => c.entity === 'collection' && !!c.data?.collector?.name)).toBe(true);
    // ...a staff member of another branch receives none.
    const otherBranch = await (await as(t, '01700000005')).get('/sync/pull?cursor=s_0');
    expect(otherBranch.body.changes.every((c: { entity: string }) => !['visit', 'collection', 'promise', 'location_proposal'].includes(c.entity))).toBe(true);
    const fs = await as(t, '01700000003');
    const before = (await fs.get('/sync/pull?cursor=s_0')).body.nextCursor;
    await applyAssignments([{ customerId: ids['100245']!, assigneeId: s.fs2.id }]);
    const after = await fs.get(`/sync/pull?cursor=${before}`);
    const c = after.body.changes.find((x: { entity: string; id: string }) => x.entity === 'customer' && x.id === ids['100245']);
    expect(c.op).toBe('delete');
  });

  it('410 CURSOR_EXPIRED for a cursor ahead of the feed or older than the retained window; 400 for garbage', async () => {
    const fs = await as(t, '01700000003');
    expect((await fs.get('/sync/pull?cursor=s_99999999')).status).toBe(410);
    expect((await fs.get('/sync/pull?cursor=abc')).status).toBe(400);
    expect((await fs.get('/sync/pull')).status).toBe(400);
    const first = await ChangeModel.findOne().sort({ seq: 1 }).lean();
    await ChangeModel.deleteMany({ seq: { $lte: first!.seq + 3 } }); // what the 30-day TTL does
    const gone = await fs.get('/sync/pull?cursor=s_0');
    expect(gone.status).toBe(410);
    expect(gone.body.code).toBe('CURSOR_EXPIRED');
  });
});

describe('sync health (FR-SYNC-005)', () => {
  it('shows per-device state to settings managers only', async () => {
    const sa = await as(t, '01700000001');
    const r = await sa.get('/system/sync-health');
    expect(r.status).toBe(200);
    expectConforms('GET', '/system/sync-health', 200, r.body);
    const row = r.body.find((x: { deviceId: string }) => x.deviceId === 'dev-01700000003');
    expect(row.pendingReported).toBe(3);
    expect(row.lastPullAt).toBeTruthy();
    expect(row.lastPushAt).toBeTruthy();
    expect((await (await as(t, '01700000002')).get('/system/sync-health')).status).toBe(403);
  });
});

describe('bootstrap of a reinstalled app (FR-SYNC-006)', () => {
  it("brings today's attendance, today's visits and the caller's open promises, not only customers", async () => {
    const fs = await as(t, '01700000003');
    const items: { entity: string; id: string; data: Record<string, unknown> }[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/sync/bootstrap?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const r: { status: number; body: { items: typeof items; nextCursor: string | null } } = await fs.get(url);
      expect(r.status).toBe(200);
      expectConforms('GET', '/sync/bootstrap', 200, r.body);
      items.push(...r.body.items);
      cursor = r.body.nextCursor;
    } while (cursor);
    const of = (e: string) => items.filter((i) => i.entity === e);
    expect(of('attendance_day')).toHaveLength(1);
    expect(of('attendance_day')[0]!.id).toBe(`${s.fs1.id}:2026-11-15`);
    expect(of('attendance_day')[0]!.data.firstIn).toBeTruthy();
    expect(of('visit').map((i) => i.data.clientId)).toContain(visitClientId);
    expect(of('promise').length).toBeGreaterThan(0);
    expect(of('promise').every((i) => typeof i.data.ownerName === 'string' && typeof i.data.createdByName === 'string')).toBe(true);
    expect(of('visit').every((i) => typeof i.data.userName === 'string' && i.data.userName !== '')).toBe(true);
    expect(of('collection').length).toBeGreaterThan(0);
    // ADR-046: a colleague of the branch gets the same branch snapshot; another branch's staff gets none of it.
    const colleague = await (await as(t, '01700000004')).get('/sync/bootstrap?limit=200');
    const kinds = new Set(colleague.body.items.map((i: { entity: string }) => i.entity));
    expect(kinds.has('visit') && kinds.has('promise') && kinds.has('collection')).toBe(true);
    const other = await (await as(t, '01700000005')).get('/sync/bootstrap?limit=200');
    expect(other.body.items.filter((i: { entity: string }) => ['visit', 'promise', 'collection', 'location_proposal'].includes(i.entity))).toEqual([]);
  });
});
