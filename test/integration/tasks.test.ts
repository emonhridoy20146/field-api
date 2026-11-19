import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, createTestApp, seedBasics, PASSWORD, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { createSystemUser, type UserView } from '../../src/modules/users/index.js';
import { AuditLogModel } from '../../src/modules/audit/models/audit-log.model.js';

let t: TestApp;
let s: Seeded;
let both: UserView; // field staff of two branches
let taskId = '';
const mut = (entity: string, payload: Record<string, unknown>) => ({ mutationId: randomUUID(), entity, op: 'create', payload });
const types = (body: { items: { type: string }[] }) => body.items.map((i) => i.type);

beforeAll(async () => {
  t = await createTestApp(); // Sunday 2026-11-15 10:00 Dhaka
  s = await seedBasics(t);
  both = await createSystemUser({ name: { en: 'Two Branch', bn: 'Two Branch' }, phone: '01700000009', role: 'field_staff', branchIds: [s.branchA, s.branchB], employeeCode: 'FS777', password: PASSWORD });
});
afterAll(async () => t.close());

describe('giving a task (FR-TASK-001)', () => {
  it('a manager gives a staff member a task with a note; a repeat of the same clientId is a replay', async () => {
    const bm = await as(t, '01700000002');
    const body = { clientId: randomUUID(), assigneeId: s.fs1.id, title: 'Collect the shop key from Karim', note: 'Ask at the tea stall near the bazaar. Call me when done.', dueDate: '2026-11-16' };
    const r = await bm.post('/tasks', body);
    expect(r.status).toBe(201);
    expectConforms('POST', '/tasks', 201, r.body);
    taskId = r.body.id;
    expect(r.body).toMatchObject({ status: 'open', branchId: s.branchA, title: body.title, note: body.note, dueDate: '2026-11-16', overdue: false, resolveNote: null, decisionNote: null });
    expect(r.body.assignee).toEqual({ id: s.fs1.id, name: 'Rakib Hasan', employeeCode: 'FS014' });
    expect(r.body.createdBy).toEqual({ id: s.bm.id, name: 'Manager A' });
    expect(r.body.events.map((e: { type: string }) => e.type)).toEqual(['created']);

    const again = await bm.post('/tasks', body);
    expect(again.status).toBe(200);
    expectConforms('POST', '/tasks', 200, again.body);
    expect(again.body.id).toBe(taskId);
  });

  it('refuses anyone who is not active field staff in the caller scope, and a due date in the past', async () => {
    const bm = await as(t, '01700000002');
    for (const bad of [s.fsB.id, s.bm.id, s.vw.id, '000000000000000000000000', 'nope']) {
      const x = await bm.post('/tasks', { assigneeId: bad, title: 'x' });
      expect(x.status).toBe(422);
      expect(x.body.details.rule).toBe('TASK_INVALID_ASSIGNEE');
    }
    const past = await bm.post('/tasks', { assigneeId: s.fs1.id, title: 'x', dueDate: '2026-11-14' });
    expect(past.status).toBe(422);
    expect(past.body.details.rule).toBe('TASK_DUE_IN_PAST');
    expect((await bm.post('/tasks', { assigneeId: s.fs1.id, title: '' })).status).toBe(400);
    expect((await bm.post('/tasks', { assigneeId: s.fs1.id, title: 'x', dueDate: 'tomorrow' })).status).toBe(400);
    expect((await (await as(t, '01700000006')).post('/tasks', { assigneeId: s.fs1.id, title: 'x' })).status).toBe(403); // viewer
    expect((await (await as(t, '01700000003')).post('/tasks', { assigneeId: s.fs2.id, title: 'x' })).status).toBe(403); // field staff
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/tasks', payload: { assigneeId: s.fs1.id, title: 'x' } })).statusCode).toBe(401);
  });

  it('a person in two branches gets one task in the branch the caller picked or can see', async () => {
    const bm = await as(t, '01700000002');
    const sa = await as(t, '01700000001');
    const a = await bm.post('/tasks', { assigneeId: both.id, title: 'Two-branch task A' });
    expect(a.status).toBe(201);
    expect(a.body.branchId).toBe(s.branchA); // the manager only sees branch A
    const b = await sa.post('/tasks', { assigneeId: both.id, title: 'Two-branch task B', branchId: s.branchB });
    expect(b.status).toBe(201);
    expect(b.body.branchId).toBe(s.branchB);
    expect((await bm.post('/tasks', { assigneeId: both.id, title: 'x', branchId: s.branchB })).status).toBe(422); // not a branch the manager sees
    expect((await sa.post('/tasks', { assigneeId: s.fs1.id, title: 'x', branchId: s.branchB })).status).toBe(422); // not a branch of the assignee
    expect((await (await as(t, '01700000009')).get('/tasks/mine')).body.items).toHaveLength(2);
  });
});

describe('the staff side (FR-TASK-002)', () => {
  it('tells the assignee by notification, own list and sync; nobody else sees it', async () => {
    const fs1 = await as(t, '01700000003');
    const n = await fs1.get('/notifications');
    const note = n.body.items.find((i: { type: string }) => i.type === 'task.assigned');
    expect(note.data.taskId).toBe(taskId);
    expect(note.body).toEqual({ bn: 'Collect the shop key from Karim', en: 'Collect the shop key from Karim' });
    const mine = await fs1.get('/tasks/mine');
    expect(mine.status).toBe(200);
    expectConforms('GET', '/tasks/mine', 200, mine.body);
    expect(mine.body.items.map((x: { id: string }) => x.id)).toEqual([taskId]);
    const pull = await fs1.get('/sync/pull?cursor=s_0');
    expectConforms('GET', '/sync/pull', 200, pull.body);
    expect(pull.body.changes.find((c: { entity: string }) => c.entity === 'task').id).toBe(taskId);
    const boot = await fs1.get('/sync/bootstrap');
    expect(boot.status).toBe(200);

    const fs2 = await as(t, '01700000004');
    expect((await fs2.get('/tasks/mine')).body.items).toEqual([]);
    expect((await fs2.post(`/tasks/${taskId}/resolve-request`, { note: 'mine now' })).status).toBe(404);
    expect((await fs1.get('/tasks')).status).toBe(403); // the list is for managers
  });

  it('a resolve request notifies the managers and raises an inbox item; a repeat changes nothing', async () => {
    t.clock.set(new Date('2026-11-15T06:00:00Z'));
    let fs1 = await as(t, '01700000003'); // sign in after moving the clock: tokens last 15 minutes
    const r = await fs1.post(`/tasks/${taskId}/resolve-request`, { note: 'Key collected, handed to the office.' });
    expect(r.status).toBe(200);
    expectConforms('POST', '/tasks/{id}/resolve-request', 200, r.body);
    expect(r.body).toMatchObject({ status: 'resolve_requested', resolveNote: 'Key collected, handed to the office.', resolveRequestedAt: '2026-11-15T06:00:00.000Z' });

    t.clock.set(new Date('2026-11-15T07:00:00Z'));
    fs1 = await as(t, '01700000003');
    const repeat = await fs1.post(`/tasks/${taskId}/resolve-request`, { note: 'again' });
    expect(repeat.status).toBe(200);
    expect(repeat.body.resolveNote).toBe('Key collected, handed to the office.');
    expect(repeat.body.events.filter((e: { type: string }) => e.type === 'resolve_requested')).toHaveLength(1);

    const bm = await as(t, '01700000002');
    expect(types((await bm.get('/notifications')).body)).toContain('task.resolve_requested');
    const inbox = await bm.get('/inbox');
    expect(inbox.body.items.find((i: { type: string }) => i.type === 'task.resolve_requested').link).toBe('/tasks?status=resolve_requested');
    // The branch B manager of nobody gets nothing: the viewer holds no task.manage.
    expect(types((await (await as(t, '01700000006')).get('/notifications')).body)).not.toContain('task.resolve_requested');
  });
});

describe('the admin decides (FR-TASK-003)', () => {
  it('rejects only with a reason; the assignee sees it and the task is open again', async () => {
    const bm = await as(t, '01700000002');
    const edit = await bm.patch(`/tasks/${taskId}`, { title: 'new title' });
    expect(edit.status).toBe(409); // already reported done
    expect(edit.body.details.reason).toBe('TASK_RESOLVE_REQUESTED');
    expect((await bm.post(`/tasks/${taskId}/reject`, {})).body.details.rule).toBe('REASON_REQUIRED');
    expect((await bm.post(`/tasks/${taskId}/reject`, { reason: 'no' })).status).toBe(422);
    const r = await bm.post(`/tasks/${taskId}/reject`, { reason: 'The key is not at the office yet.' });
    expect(r.status).toBe(200);
    expectConforms('POST', '/tasks/{id}/reject', 200, r.body);
    expect(r.body).toMatchObject({ status: 'open', decisionNote: 'The key is not at the office yet.', resolveNote: null, resolveRequestedAt: null });
    expect(r.body.events.map((e: { type: string }) => e.type)).toEqual(['created', 'resolve_requested', 'rejected']);

    const fs1 = await as(t, '01700000003');
    expect(types((await fs1.get('/notifications')).body)).toContain('task.decided');
    expect((await fs1.get('/tasks/mine')).body.items[0]).toMatchObject({ id: taskId, status: 'open', decisionNote: 'The key is not at the office yet.' });
    // The inbox item closed with the decision.
    expect(types((await bm.get('/inbox')).body)).not.toContain('task.resolve_requested');
    expect((await bm.post(`/tasks/${taskId}/reject`, { reason: 'once more please' })).status).toBe(409); // nothing to reject now
    expect((await bm.post(`/tasks/${taskId}/verify`, {})).status).toBe(409); // not reported done yet
  });

  it('an offline phone sends the resolve request through sync; the admin verifies; every step is idempotent', async () => {
    const tapped = '2026-11-15T08:00:00Z';
    t.clock.set(new Date('2026-11-15T09:30:00Z'));
    const fs1 = await as(t, '01700000003');
    const push = await fs1.post('/sync/push', { deviceId: 'dev-01700000003', mutations: [mut('task_resolve_request', { taskId, note: 'Got it now', requestedAt: tapped })] });
    expect(push.status).toBe(200);
    expect(push.body.results[0]).toMatchObject({ result: 'applied', entityId: taskId });
    const after = await fs1.get('/tasks/mine');
    expect(after.body.items[0]).toMatchObject({ status: 'resolve_requested', resolveNote: 'Got it now', resolveRequestedAt: tapped.replace('Z', '.000Z') });
    // a retry under a new mutation id (phone restarted) is harmless
    expect((await fs1.post('/sync/push', { deviceId: 'dev-01700000003', mutations: [mut('task_resolve_request', { taskId })] })).body.results[0].result).toBe('applied');
    // someone else's task is refused per item
    const bad = await (await as(t, '01700000004')).post('/sync/push', { deviceId: 'dev-01700000004', mutations: [mut('task_resolve_request', { taskId })] });
    expect(bad.body.results[0].result).toBe('rejected');
    // a time in the future is not believed
    expect((await fs1.post('/sync/push', { deviceId: 'dev-01700000003', mutations: [mut('task_resolve_request', { taskId, requestedAt: '2030-01-01T00:00:00Z' })] })).status).toBe(200);

    const bm = await as(t, '01700000002');
    const v = await bm.post(`/tasks/${taskId}/verify`, { note: 'Thanks' });
    expect(v.status).toBe(200);
    expectConforms('POST', '/tasks/{id}/verify', 200, v.body);
    expect(v.body).toMatchObject({ status: 'resolved', decisionNote: 'Thanks', decidedBy: { id: s.bm.id, name: 'Manager A' } });
    const again = await bm.post(`/tasks/${taskId}/verify`, {});
    expect(again.status).toBe(200);
    expect(again.body.decisionNote).toBe('Thanks');
    expect((await bm.post(`/tasks/${taskId}/cancel`, {})).status).toBe(409); // too late
    expect((await fs1.post(`/tasks/${taskId}/resolve-request`, {})).status).toBe(409); // closed
    expect((await bm.patch(`/tasks/${taskId}`, { note: 'x' })).status).toBe(409);
    expect(types((await fs1.get('/notifications')).body).filter((x) => x === 'task.decided')).toHaveLength(2);
  });

  it('cancels an open task, idempotently, and tells the assignee', async () => {
    const bm = await as(t, '01700000002');
    const made = await bm.post('/tasks', { assigneeId: s.fs2.id, title: 'Visit the new market' });
    const c = await bm.post(`/tasks/${made.body.id}/cancel`, { note: 'Not needed any more' });
    expect(c.status).toBe(200);
    expectConforms('POST', '/tasks/{id}/cancel', 200, c.body);
    expect(c.body.status).toBe('cancelled');
    expect((await bm.post(`/tasks/${made.body.id}/cancel`, {})).status).toBe(200);
    const fs2 = await as(t, '01700000004');
    expect((await fs2.post(`/tasks/${made.body.id}/resolve-request`, {})).status).toBe(409);
    expect(types((await fs2.get('/notifications')).body)).toContain('task.decided');
  });
});

describe('the manager list (FR-TASK-004)', () => {
  it('filters by status, person and words; counts every state; edits an open task', async () => {
    const bm = await as(t, '01700000002');
    const all = await bm.get('/tasks');
    expect(all.status).toBe(200);
    expectConforms('GET', '/tasks', 200, all.body);
    expect(all.body.counts).toMatchObject({ open: 1, resolve_requested: 0, resolved: 1, cancelled: 1, overdue: 0 }) // branch B's task is not in this manager's scope;
    expect((await bm.get('/tasks?status=resolved')).body.items.map((x: { id: string }) => x.id)).toEqual([taskId]);
    expect((await bm.get(`/tasks?assigneeId=${s.fs2.id}`)).body.items).toHaveLength(1);
    expect((await bm.get('/tasks?q=market')).body.items).toHaveLength(1);
    expect((await bm.get('/tasks?q=(')).status).toBe(200); // regex characters are plain text
    const page = await bm.get('/tasks?limit=2');
    expect(page.body.items).toHaveLength(2);
    expect(page.body.nextCursor).toBeTruthy();
    expect((await bm.get(`/tasks?limit=2&cursor=${page.body.nextCursor}`)).body.items.length).toBeGreaterThan(0);

    const open = all.body.items.find((x: { title: string }) => x.title === 'Two-branch task A');
    const e = await bm.patch(`/tasks/${open.id}`, { title: 'Two-branch task A (changed)', note: null, dueDate: '2026-11-20' });
    expect(e.status).toBe(200);
    expectConforms('PATCH', '/tasks/{id}', 200, e.body);
    expect(e.body).toMatchObject({ title: 'Two-branch task A (changed)', note: null, dueDate: '2026-11-20' });
    expect(e.body.events.map((x: { type: string }) => x.type)).toEqual(['created', 'edited']);
    expect((await bm.patch(`/tasks/${open.id}`, {})).status).toBe(400);
    expect((await bm.patch(`/tasks/${open.id}`, { dueDate: '2026-11-01' })).status).toBe(422);
    expectConforms('GET', '/tasks/{id}', 200, (await bm.get(`/tasks/${open.id}`)).body);
  });

  it('marks unfinished tasks past their due date as overdue', async () => {
    const bm = await as(t, '01700000002');
    const made = await bm.post('/tasks', { assigneeId: s.fs2.id, title: 'Due today', dueDate: '2026-11-15' });
    t.clock.set(new Date('2026-11-15T17:59:00Z')); // still 23:59 on the 15th in Dhaka
    let again = await as(t, '01700000002');
    expect((await again.get(`/tasks/${made.body.id}`)).body.overdue).toBe(false);
    t.clock.set(new Date('2026-11-15T18:01:00Z')); // after Dhaka midnight
    again = await as(t, '01700000002');
    expect((await again.get(`/tasks/${made.body.id}`)).body.overdue).toBe(true);
    const list = await again.get('/tasks?overdue=true');
    expect(list.body.items.map((x: { id: string }) => x.id)).toEqual([made.body.id]);
    expect(list.body.counts.overdue).toBe(1);
    expect((await again.get('/tasks?overdue=true&status=resolved')).body.items).toEqual([]);
  });

  it('keeps other branches out: the list and every id are 404 for a manager outside the branch', async () => {
    const sa = await as(t, '01700000001');
    const bm = await as(t, '01700000002');
    const other = await sa.post('/tasks', { assigneeId: s.fsB.id, title: 'Branch B only' });
    expect(other.status).toBe(201);
    expect((await bm.get('/tasks')).body.items.some((x: { id: string }) => x.id === other.body.id)).toBe(false);
    for (const call of [bm.get(`/tasks/${other.body.id}`), bm.patch(`/tasks/${other.body.id}`, { title: 'x' }), bm.post(`/tasks/${other.body.id}/verify`, {}), bm.post(`/tasks/${other.body.id}/cancel`, {})]) expect((await call).status).toBe(404);
    expect((await bm.get('/tasks/not-an-id')).status).toBe(404);
    expect((await sa.get('/tasks')).body.items.some((x: { id: string }) => x.id === other.body.id)).toBe(true);
    expect((await (await as(t, '01700000006')).get('/tasks')).status).toBe(200); // viewer can read
  });

  it('writes an audit entry for every manager step', async () => {
    const actions = (await AuditLogModel.find({ entity: 'task', entityId: taskId }).sort({ _id: 1 }).lean()).map((a) => a.action);
    expect(actions).toEqual(['task.created', 'task.resolve_requested', 'task.rejected', 'task.resolve_requested', 'task.verified']);
  });
});
