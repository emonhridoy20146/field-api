import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { AuditLogModel } from '../../src/modules/audit/models/audit-log.model.js';

// Contract 1.12.0: holiday ids + delete, my shift, leave cancel + filters, broadcast recipients,
// offline "read" through sync, guarantor contact target (the REST path is in fieldwork.test.ts).
let t: TestApp;
let s: Seeded;

beforeAll(async () => {
  t = await createTestApp(); // 2026-11-15 10:00 Dhaka
  s = await seedBasics(t);
});
afterAll(async () => t.close());

const mut = (entity: string, payload: Record<string, unknown>) => ({ mutationId: randomUUID(), entity, op: 'create', payload });

describe('holiday calendar (FR-SET-002, 1.12.0)', () => {
  it('lists with ids, filters by branch, refuses duplicates and mismatched scope, deletes with audit', async () => {
    const sa = await as(t, '01700000001');
    const bm = await as(t, '01700000002');
    const fs = await as(t, '01700000003');
    const nat = await sa.post('/calendar/holidays', { date: '2026-12-16', name: { bn: 'বিজয় দিবস', en: 'Victory Day' } });
    expect(nat.status).toBe(201);
    expectConforms('POST', '/calendar/holidays', 201, nat.body);
    expect(nat.body.id).toMatch(/^[a-f0-9]{24}$/);
    // national already covers every branch on that day
    expect((await sa.post('/calendar/holidays', { date: '2026-12-16', name: { bn: 'ক', en: 'a' }, type: 'branch', branchIds: [s.branchA] })).status).toBe(409);
    // scope must match the type
    expect((await sa.post('/calendar/holidays', { date: '2026-12-20', name: { bn: 'ক', en: 'a' }, type: 'branch' })).status).toBe(400);
    expect((await sa.post('/calendar/holidays', { date: '2026-12-20', name: { bn: 'ক', en: 'a' }, branchIds: [s.branchA] })).status).toBe(400);
    const own = await sa.post('/calendar/holidays', { date: '2026-12-21', name: { bn: 'শাখা দিবস', en: 'Branch day' }, type: 'branch', branchIds: [s.branchB] });
    expect(own.status).toBe(201);
    // managers and staff may read; only settings.manage writes
    expect((await bm.post('/calendar/holidays', { date: '2026-12-25', name: { bn: 'ক', en: 'a' } })).status).toBe(403);
    const mine = await fs.get(`/calendar/holidays?year=2026&branchId=${s.branchA}`);
    expect(mine.status).toBe(200);
    expectConforms('GET', '/calendar/holidays', 200, mine.body);
    expect(mine.body.map((h: { date: string }) => h.date)).toEqual(['2026-12-16']);
    expect((await fs.get('/calendar/holidays?year=2026')).body).toHaveLength(2);

    expect((await bm.delete(`/calendar/holidays/${own.body.id}`)).status).toBe(403);
    expect((await sa.delete(`/calendar/holidays/${'a'.repeat(24)}`)).status).toBe(404);
    expect((await sa.delete(`/calendar/holidays/${own.body.id}`)).status).toBe(204);
    expect((await sa.delete(`/calendar/holidays/${own.body.id}`)).status).toBe(404);
    expect((await fs.get('/calendar/holidays?year=2026')).body).toHaveLength(1);
    expect(await AuditLogModel.countDocuments({ action: 'holiday.deleted', entityId: own.body.id })).toBe(1);
  });
});

describe('my shift (FR-SET-003, 1.12.0)', () => {
  it('answers the branch default, then the assigned shift', async () => {
    const sa = await as(t, '01700000001');
    const fs = await as(t, '01700000003');
    const def = await fs.get('/attendance/me/shift');
    expect(def.status).toBe(200);
    expectConforms('GET', '/attendance/me/shift', 200, def.body);
    expect(def.body.id).toBe('default');
    const sh = await sa.post('/shifts', { name: 'Morning', start: '08:00', end: '17:00', weeklyOff: [5, 6] });
    expect(sh.status).toBe(201);
    expect((await sa.patch(`/users/${s.fs1.id}`, { shiftId: sh.body.id, reason: 'Morning route from next week' })).status).toBe(200);
    const mine = await fs.get('/attendance/me/shift');
    expect(mine.body).toMatchObject({ id: sh.body.id, name: 'Morning', start: '08:00', end: '17:00', weeklyOff: [5, 6] });
    // viewers do not record attendance
    expect((await (await as(t, '01700000006')).get('/attendance/me/shift')).status).toBe(403);
  });
});

describe('leave: cancel and filters (FR-ATT-008, 1.12.0)', () => {
  it('staff cancel their own pending request, then can ask again; decided ones stay', async () => {
    const fs = await as(t, '01700000003');
    const fs2 = await as(t, '01700000004');
    const bm = await as(t, '01700000002');
    const wrong = await fs.post('/leave-requests', { type: 'casual', from: '2026-11-24', to: '2026-11-26', reason: 'Sister wedding' });
    expect(wrong.status).toBe(201);
    expectConforms('POST', '/leave-requests', 201, wrong.body);
    expect(wrong.body.days).toBe(3);
    // overlap blocks a corrected request until the first one is withdrawn
    expect((await fs.post('/leave-requests', { type: 'casual', from: '2026-11-25', to: '2026-11-26' })).status).toBe(409);
    expect((await fs2.post(`/leave-requests/${wrong.body.id}/cancel`)).status).toBe(404);
    expect((await bm.post(`/leave-requests/${wrong.body.id}/cancel`)).status).toBe(403);
    const c = await fs.post(`/leave-requests/${wrong.body.id}/cancel`);
    expect(c.status).toBe(200);
    expectConforms('POST', '/leave-requests/{id}/cancel', 200, c.body);
    expect(c.body.status).toBe('cancelled');
    expect(c.body.cancelledAt).toBeTruthy();
    expect((await fs.post(`/leave-requests/${wrong.body.id}/cancel`)).body.status).toBe('cancelled'); // repeat is harmless
    expect((await bm.post(`/leave-requests/${wrong.body.id}/decision`, { decision: 'approve' })).status).toBe(409);
    // the manager's inbox item went away with it
    const inbox = await bm.get('/inbox?type=leave.requested');
    expect(inbox.body.items.some((i: { entityId: string }) => i.entityId === wrong.body.id)).toBe(false);

    const right = await fs.post('/leave-requests', { type: 'casual', from: '2026-11-25', to: '2026-11-26', reason: 'Sister wedding' });
    expect(right.status).toBe(201);
    const rej = await bm.post(`/leave-requests/${right.body.id}/decision`, { decision: 'reject', reason: 'Collection drive that week' });
    expect(rej.status).toBe(200);
    expectConforms('POST', '/leave-requests/{id}/decision', 200, rej.body);
    expect(rej.body.decisionReason).toBe('Collection drive that week');
    expect((await fs.post(`/leave-requests/${right.body.id}/cancel`)).status).toBe(409);
  });

  it('filters by window, person and status; staff never see others', async () => {
    const fs = await as(t, '01700000003');
    const fs2 = await as(t, '01700000004');
    const bm = await as(t, '01700000002');
    const a = await fs2.post('/leave-requests', { type: 'sick', from: '2026-12-01', to: '2026-12-02' });
    expect(a.status).toBe(201);
    const nov = await bm.get('/leave-requests?from=2026-11-01&to=2026-11-30');
    expectConforms('GET', '/leave-requests', 200, nov.body);
    expect(nov.body.items.every((l: { from: string; to: string }) => l.from <= '2026-11-30' && l.to >= '2026-11-01')).toBe(true);
    expect(nov.body.items.some((l: { id: string }) => l.id === a.body.id)).toBe(false);
    const dec = await bm.get(`/leave-requests?from=2026-12-01&to=2026-12-31&userId=${s.fs2.id}`);
    expect(dec.body.items.map((l: { id: string }) => l.id)).toEqual([a.body.id]);
    expect(dec.body.items[0].branchId).toBe(s.branchA);
    expect((await bm.get('/leave-requests?status=cancelled')).body.items).toHaveLength(1);
    expect((await bm.get('/leave-requests?from=2026-12-02&to=2026-12-01')).status).toBe(400);
    // a staff member's userId filter is ignored: still only their own
    const own = await fs.get(`/leave-requests?userId=${s.fs2.id}`);
    expect(own.body.items.every((l: { userId: string }) => l.userId === s.fs1.id)).toBe(true);
  });
});

describe('notices: who read, offline read (FR-NOT-005, 1.12.0)', () => {
  it('lists recipients not-read first, records the tap time from sync, scopes to the sender', async () => {
    const bm = await as(t, '01700000002');
    const fs = await as(t, '01700000003');
    const b = await bm.post('/broadcasts', { title: { bn: 'নতুন নিয়ম', en: 'New rule' }, body: { bn: 'রসিদ ছাড়া টাকা নেবেন না।', en: 'Never take money without a receipt.' }, requireAck: true });
    expect(b.status).toBe(201);
    const id = b.body.id as string;

    expect((await fs.get(`/broadcasts/${id}/recipients`)).status).toBe(403);
    const before = await bm.get(`/broadcasts/${id}/recipients`);
    expect(before.status).toBe(200);
    expectConforms('GET', '/broadcasts/{id}/recipients', 200, before.body);
    expect(before.body.ackCount).toBe(0);
    expect(before.body.items.map((r: { userId: string }) => r.userId).sort()).toEqual([s.fs1.id, s.fs2.id].sort());

    // fs reads it offline at 10:05; the phone syncs at 10:30 (fresh sessions after the clock moves)
    t.clock.set('2026-11-15T04:30:00Z');
    const fsLater = await as(t, '01700000003');
    const fs2Later = await as(t, '01700000004');
    const bmLater = await as(t, '01700000002');
    const tapped = '2026-11-15T04:05:00Z';
    const push = await fsLater.post('/sync/push', { deviceId: 'dev-01700000003', mutations: [mut('broadcast_ack', { broadcastId: id, at: tapped })] });
    expect(push.status).toBe(200);
    expect(push.body.results[0]).toMatchObject({ result: 'applied', entityId: id });
    // a second tap, online, changes nothing
    expect((await fsLater.post(`/broadcasts/${id}/ack`)).status).toBe(204);
    // a time before sending is not believed
    expect((await fs2Later.post('/sync/push', { deviceId: 'dev-01700000004', mutations: [mut('broadcast_ack', { broadcastId: id, at: '2020-01-01T00:00:00Z' })] })).body.results[0].result).toBe('applied');
    // not a recipient → rejected per item, not the batch
    const bad = await (await as(t, '01700000005')).post('/sync/push', { deviceId: 'dev-01700000005', mutations: [mut('broadcast_ack', { broadcastId: id })] });
    expect(bad.body.results[0].result).toBe('rejected');

    const after = await bmLater.get(`/broadcasts/${id}/recipients`);
    expect(after.body.ackCount).toBe(2);
    const r1 = after.body.items.find((r: { userId: string }) => r.userId === s.fs1.id);
    expect(r1).toMatchObject({ acked: true, ackedAt: '2026-11-15T04:05:00.000Z', employeeCode: 'FS014' });
    const r2 = after.body.items.find((r: { userId: string }) => r.userId === s.fs2.id);
    expect(r2.ackedAt).toBe('2026-11-15T04:30:00.000Z');
    const mine = await fsLater.get('/broadcasts');
    expect(mine.body.items[0]).toMatchObject({ id, acked: true, ackedAt: '2026-11-15T04:05:00.000Z' });
    // the phone's copy follows through pull
    const pull = await fsLater.get('/sync/pull?cursor=s_0');
    const ch = pull.body.changes.filter((c: { entity: string; id: string }) => c.entity === 'broadcast' && c.id === id);
    expect(ch.at(-1).data.acked).toBe(true);

    // a manager of another branch cannot look into it
    const sa = await as(t, '01700000001');
    expect((await sa.get(`/broadcasts/${id}/recipients`)).status).toBe(200);
    expect((await bmLater.get(`/broadcasts/${'a'.repeat(24)}/recipients`)).status).toBe(404);
  });
});

describe('guarantor calls through sync (FR-M-014, 1.12.0)', () => {
  it('refuses an unknown contact target per item', async () => {
    const fs = await as(t, '01700000003');
    const bad = await fs.post('/sync/push', { deviceId: 'dev-01700000003', mutations: [mut('contact_attempt', { clientId: randomUUID(), customerId: 'a'.repeat(24), channel: 'call', target: 'neighbour', at: '2026-11-15T04:00:00Z' })] });
    expect(bad.body.results[0].result).toBe('rejected');
    expect(bad.body.results[0].error.code).toBe('VALIDATION_FAILED');
  });
});
