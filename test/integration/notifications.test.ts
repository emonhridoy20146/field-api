import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { MemoryPushSender, notify, setPushSender } from '../../src/modules/notifications/index.js';

let t: TestApp;
let s: Seeded;
const push = new MemoryPushSender();
const TOKEN = 'fcm-token-for-tests-0000000000000001';

beforeAll(async () => {
  t = await createTestApp(); // 10:00 Dhaka
  s = await seedBasics(t);
  setPushSender(push);
});
afterAll(async () => t.close());

describe('push token and center (FR-NOT-001/003)', () => {
  it('registers a token for the session device and delivers a stored + pushed notification', async () => {
    const fs = await as(t, '01700000003');
    expect((await fs.post('/devices/push-token', { deviceId: 'dev-01700000003', fcmToken: 'short' })).status).toBe(400);
    expect((await fs.post('/devices/push-token', { deviceId: 'dev-01700000003', fcmToken: TOKEN })).status).toBe(204);
    await notify({ userIds: [s.fs1.id], type: 'promise.due', title: { bn: 'শিরোনাম', en: 'Title' }, body: { bn: 'বার্তা', en: 'Body' }, data: { promiseId: 'p1' } });
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.tokens).toEqual([TOKEN]);
    const l = await fs.get('/notifications');
    expect(l.status).toBe(200);
    expectConforms('GET', '/notifications', 200, l.body);
    expect(l.body.unreadCount).toBe(1);
    expect(l.body.items[0].data.promiseId).toBe('p1');
    // someone else cannot read or mark it
    const other = await as(t, '01700000004');
    expect((await other.get('/notifications')).body.items).toEqual([]);
    expect((await other.post(`/notifications/${l.body.items[0].id}/read`)).status).toBe(404);
    expect((await fs.post(`/notifications/${l.body.items[0].id}/read`)).status).toBe(204);
    expect((await fs.get('/notifications?unread=true')).body.items).toEqual([]);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/notifications' })).statusCode).toBe(401);
    // reaches the app through sync as well
    const pull = await fs.get('/sync/pull?cursor=s_0');
    expect(pull.body.changes.some((c: { entity: string }) => c.entity === 'notification')).toBe(true);
  });

  it('quiet hours store but do not push; invalid tokens are dropped', async () => {
    t.clock.set('2026-11-15T16:00:00Z'); // 22:00 Dhaka
    push.sent = [];
    await notify({ userIds: [s.fs1.id], type: 'promise.due', title: { bn: 'ক', en: 'a' }, body: { bn: 'খ', en: 'b' } });
    expect(push.sent).toHaveLength(0);
    const fs = await as(t, '01700000003');
    expect((await fs.get('/notifications')).body.unreadCount).toBe(1);
    expect((await fs.post('/notifications/read-all')).status).toBe(204);
    t.clock.set('2026-11-16T04:00:00Z'); // 10:00 Dhaka next day
    push.invalid.add(TOKEN);
    await notify({ userIds: [s.fs1.id], type: 'promise.due', title: { bn: 'ক', en: 'a' }, body: { bn: 'খ', en: 'b' } });
    expect(push.sent).toHaveLength(1);
    await notify({ userIds: [s.fs1.id], type: 'promise.due', title: { bn: 'ক', en: 'a' }, body: { bn: 'খ', en: 'b' } });
    expect(push.sent).toHaveLength(1); // token was dropped
  });
});

describe('events become notifications (FR-NOT-002)', () => {
  it('leave request tells managers, decision tells the staff member', async () => {
    const fs = await as(t, '01700000003');
    const bm = await as(t, '01700000002');
    const l = await fs.post('/leave-requests', { type: 'casual', from: '2026-11-20', to: '2026-11-20' });
    const bmList = await bm.get('/notifications');
    expect(bmList.body.items[0].type).toBe('leave.requested');
    expect(bmList.body.items[0].data.leaveId).toBe(l.body.id);
    await bm.post(`/leave-requests/${l.body.id}/decision`, { decision: 'approve' });
    const mine = await fs.get('/notifications?unread=true');
    expect(mine.body.items[0].type).toBe('leave.decided');
    expect(mine.body.items[0].title.bn).toBeTruthy();
  });
});

describe('broadcasts (FR-NOT-005)', () => {
  it('sends to staff in scope, lists, acknowledges', async () => {
    const bm = await as(t, '01700000002');
    const fs = await as(t, '01700000003');
    expect((await fs.post('/broadcasts', { title: { bn: 'ক' }, body: { bn: 'খ' } })).status).toBe(403);
    expect((await bm.post('/broadcasts', { title: { bn: '' }, body: { bn: 'খ' } })).status).toBe(400);
    expect((await bm.post('/broadcasts', { title: { bn: 'ক' }, body: { bn: 'খ' }, branchIds: ['a'.repeat(24)] })).status).toBe(404);
    const b = await bm.post('/broadcasts', { title: { bn: 'সভা', en: 'Meeting' }, body: { bn: 'কাল সকাল ৯টায়', en: 'Tomorrow 9 am' }, requireAck: true });
    expect(b.status).toBe(201);
    expect(b.body.recipientCount).toBeGreaterThanOrEqual(2);
    const mine = await fs.get('/broadcasts');
    expectConforms('GET', '/broadcasts', 200, mine.body);
    expect(mine.body.items[0].acked).toBe(false);
    expect((await fs.get('/notifications?unread=true')).body.items[0].type).toBe('announcement');
    expect((await fs.post(`/broadcasts/${b.body.id}/ack`)).status).toBe(204);
    expect((await fs.post(`/broadcasts/${b.body.id}/ack`)).status).toBe(204);
    expect((await bm.get('/broadcasts')).body.items[0].ackCount).toBe(1);
    expect((await (await as(t, '01700000006')).post(`/broadcasts/${b.body.id}/ack`)).status).toBe(404); // not a recipient
  });
});
