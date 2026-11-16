import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, createTestApp, seedBasics, PASSWORD, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { applyAssignments, getByErpId } from '../../src/modules/customers/index.js';
import { createSystemUser, type UserView } from '../../src/modules/users/index.js';
import { setSystem } from '../../src/modules/settings/index.js';
import { endPastSessions } from '../../src/modules/cowork/service.js';

let t: TestApp;
let s: Seeded;
let fs3: UserView;
let fsB2: UserView;
const cust: Record<string, string> = {};
let sessionId = '';
let secondId = '';
const geo = { lat: 22.7106, lng: 90.3703, accuracyM: 9 };
const visit = (customer: string, at: string, coWorkSessionId?: string) => ({ clientId: randomUUID(), customerId: cust[customer], checkInAt: at, outcome: 'not_home', geo, ...(coWorkSessionId ? { coWorkSessionId } : {}) });
const statusOf = (body: { members: { userId: string; status: string }[] }, id: string) => body.members.find((m) => m.userId === id)?.status;

beforeAll(async () => {
  t = await createTestApp(); // Sunday 2026-11-15 10:00 Dhaka
  s = await seedBasics(t);
  fs3 = await createSystemUser({ name: { en: 'Jamal Uddin', bn: 'Jamal Uddin' }, phone: '01700000007', role: 'field_staff', branchIds: [s.branchA], employeeCode: 'FS016', password: PASSWORD });
  fsB2 = await createSystemUser({ name: { en: 'Kabir B', bn: 'Kabir B' }, phone: '01700000008', role: 'field_staff', branchIds: [s.branchB], employeeCode: 'FS102', password: PASSWORD });
  await deltaSync();
  for (const e of ['100245', '100246', '100248']) cust[e] = (await getByErpId(e))!.id;
  await applyAssignments([
    { customerId: cust['100245']!, assigneeId: s.fs1.id },
    { customerId: cust['100246']!, assigneeId: s.fs1.id },
    { customerId: cust['100248']!, assigneeId: fs3.id },
  ]);
});
afterAll(async () => t.close());

describe('co-work requests (FR-CW-001)', () => {
  it('invites colleagues of the same branch, idempotently, and refuses everyone else', async () => {
    const fs1 = await as(t, '01700000003');
    const body = { clientId: randomUUID(), toUserIds: [s.fs2.id, fs3.id], note: 'Market area' };
    const r = await fs1.post('/cowork/requests', body);
    expect(r.status).toBe(201);
    expectConforms('POST', '/cowork/requests', 201, r.body);
    sessionId = r.body.id;
    expect(r.body.status).toBe('open');
    expect(r.body.businessDate).toBe('2026-11-15');
    expect(statusOf(r.body, s.fs1.id)).toBe('accepted');
    expect(statusOf(r.body, s.fs2.id)).toBe('invited');
    expect(r.body.members.find((m: { userId: string }) => m.userId === s.fs2.id).name).toBe('Sumon Mia');

    const replay = await fs1.post('/cowork/requests', body);
    expect(replay.status).toBe(200);
    expectConforms('POST', '/cowork/requests', 200, replay.body);
    expect(replay.body.id).toBe(sessionId);

    for (const bad of [s.fsB.id, s.fs1.id, s.bm.id, '000000000000000000000000', 'nope']) {
      const x = await fs1.post('/cowork/requests', { clientId: randomUUID(), toUserIds: [bad] });
      expect(x.status).toBe(422);
      expect(x.body.details.rule).toBe('COWORK_INVALID_INVITEE');
    }
    expect((await fs1.post('/cowork/requests', { clientId: 'x', toUserIds: [] })).status).toBe(400);
    expect((await (await as(t, '01700000002')).post('/cowork/requests', body)).status).toBe(403); // managers do not co-work
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/cowork/requests', payload: body })).statusCode).toBe(401);
  });

  it('tells the invitee by notification, own list and sync', async () => {
    const fs2 = await as(t, '01700000004');
    const mine = await fs2.get('/cowork/sessions/mine');
    expect(mine.status).toBe(200);
    expectConforms('GET', '/cowork/sessions/mine', 200, mine.body);
    expect(mine.body.map((x: { id: string }) => x.id)).toEqual([sessionId]);
    const n = await fs2.get('/notifications');
    expect(n.body.items.some((i: { type: string }) => i.type === 'cowork.requested')).toBe(true);
    const pull = await fs2.get('/sync/pull?cursor=s_0');
    expectConforms('GET', '/sync/pull', 200, pull.body);
    const change = pull.body.changes.find((c: { entity: string }) => c.entity === 'cowork_session');
    expect(change.id).toBe(sessionId);
    expect(change.data.members).toHaveLength(3);
    expect(pull.body.settings['cowork.maxMembers']).toBe(5);
    // Someone outside the session gets nothing.
    expect((await (await as(t, '01700000005')).get('/cowork/sessions/mine')).body).toEqual([]);
  });

  it('accept, reject, and the one-session-at-a-time rule', async () => {
    const fs1 = await as(t, '01700000003');
    const fs2 = await as(t, '01700000004');
    const three = await as(t, '01700000007');
    // Before anyone accepted there is no partner: a plain single visit, no flag.
    const early = await fs1.post('/visits', visit('100245', '2026-11-15T04:00:00Z', sessionId));
    expect(early.status).toBe(201);
    expectConforms('POST', '/visits', 201, early.body);
    expect(early.body.coWork).toBeNull();
    expect(early.body.flags).not.toContain('cowork_invalid');

    t.clock.set(new Date('2026-11-15T04:10:00Z'));
    expect((await fs2.post(`/cowork/sessions/${sessionId}/respond`, { decision: 'maybe' })).status).toBe(400);
    const acc = await fs2.post(`/cowork/sessions/${sessionId}/respond`, { decision: 'accept' });
    expect(acc.status).toBe(200);
    expectConforms('POST', '/cowork/sessions/{id}/respond', 200, acc.body);
    expect(statusOf(acc.body, s.fs2.id)).toBe('accepted');
    expect((await fs2.post(`/cowork/sessions/${sessionId}/respond`, { decision: 'accept' })).status).toBe(200); // replay
    const rej = await three.post(`/cowork/sessions/${sessionId}/respond`, { decision: 'reject' });
    expect(statusOf(rej.body, fs3.id)).toBe('rejected');
    expect(rej.body.status).toBe('open');
    const back = await three.post(`/cowork/sessions/${sessionId}/respond`, { decision: 'accept' });
    expect(back.status).toBe(409);
    expect(back.body.details.reason).toBe('NOT_INVITED');
    expect((await fs1.get('/notifications')).body.items.filter((i: { type: string }) => i.type === 'cowork.responded')).toHaveLength(2);

    // Not a member: the session does not exist for them.
    expect((await (await as(t, '01700000005')).post(`/cowork/sessions/${sessionId}/respond`, { decision: 'accept' })).status).toBe(404);
    expect((await fs2.post('/cowork/sessions/not-an-id/leave')).status).toBe(404);

    // fs3 starts a group of their own and invites fs2, who is already working with fs1.
    const second = await three.post('/cowork/requests', { clientId: randomUUID(), toUserIds: [s.fs2.id] });
    expect(second.status).toBe(201);
    secondId = second.body.id;
    expect(secondId).not.toBe(sessionId);
    const busy = await fs2.post(`/cowork/sessions/${secondId}/respond`, { decision: 'accept' });
    expect(busy.status).toBe(409);
    expect(busy.body.details.reason).toBe('ALREADY_IN_SESSION');

    await setSystem('cowork.maxMembers', 2, s.branchA);
    const many = await fs1.post('/cowork/requests', { clientId: randomUUID(), toUserIds: [fs3.id] });
    expect(many.status).toBe(422);
    expect(many.body.details.rule).toBe('COWORK_TOO_MANY');
    await setSystem('cowork.maxMembers', 5, s.branchA);
  });
});

describe('co-work visits (FR-CW-003)', () => {
  it('stores the partners of the moment and shows the visit to them', async () => {
    t.clock.set(new Date('2026-11-15T04:40:00Z'));
    const fs1 = await as(t, '01700000003');
    const fs2 = await as(t, '01700000004');
    const three = await as(t, '01700000007');
    const v = await fs1.post('/visits', visit('100245', '2026-11-15T04:20:00Z', sessionId));
    expect(v.status).toBe(201);
    expectConforms('POST', '/visits', 201, v.body);
    expect(v.body.coWork).toEqual({ sessionId, participantIds: [s.fs2.id] });
    // Both members record the same stop: still one joint visit in the figures.
    expect((await fs2.post('/visits', visit('100245', '2026-11-15T04:22:00Z', sessionId))).body.coWork.participantIds).toEqual([s.fs1.id]);
    expect((await fs2.post('/visits', visit('100246', '2026-11-15T04:30:00Z', sessionId))).body.coWork.participantIds).toEqual([s.fs1.id]);

    // fs3 rejected the invitation, so a claim of co-work is not believed; the visit itself is kept.
    const fake = await three.post('/visits', visit('100248', '2026-11-15T04:25:00Z', sessionId));
    expect(fake.status).toBe(201);
    expect(fake.body.coWork).toBeNull();
    expect(fake.body.flags).toContain('cowork_invalid');
    expect((await three.post('/visits', visit('100248', '2026-11-15T04:26:00Z', 'garbage'))).body.flags).toContain('cowork_invalid');

    const list = await fs2.get('/visits?coWork=true');
    expectConforms('GET', '/visits', 200, list.body);
    expect(list.body.items).toHaveLength(3); // two own + the one fs1 recorded with them
    const shared = list.body.items.find((i: { id: string }) => i.id === v.body.id);
    expect(shared.coWork.participants).toEqual([{ id: s.fs2.id, name: 'Sumon Mia' }]);
    expect((await three.get('/visits?coWork=true')).body.items).toHaveLength(0);
    const pull = await fs2.get('/sync/pull?cursor=s_0');
    expect(pull.body.changes.some((c: { entity: string; id: string }) => c.entity === 'visit' && c.id === v.body.id)).toBe(true);
  });
});

describe('manager view (FR-CW-004)', () => {
  it('lists sessions with visit counts and filters visits by kind', async () => {
    const bm = await as(t, '01700000002');
    const l = await bm.get('/cowork/sessions?from=2026-11-15&to=2026-11-15');
    expect(l.status).toBe(200);
    expectConforms('GET', '/cowork/sessions', 200, l.body);
    expect(l.body.items.map((x: { id: string }) => x.id)).toEqual([secondId, sessionId]);
    expect(l.body.items[1].visitsCount).toBe(2); // two customers, although three records
    expect((await bm.get(`/cowork/sessions?userId=${s.fs1.id}`)).body.items).toHaveLength(1);
    expect((await bm.get('/cowork/sessions?limit=1')).body.nextCursor).toBeTruthy();
    const one = await bm.get(`/cowork/sessions/${sessionId}`);
    expectConforms('GET', '/cowork/sessions/{id}', 200, one.body);
    expect(one.body.visitsCount).toBe(2);
    expect((await (await as(t, '01700000006')).get('/cowork/sessions')).status).toBe(200); // viewer
    expect((await (await as(t, '01700000003')).get('/cowork/sessions')).status).toBe(403);
    expect((await bm.get('/cowork/sessions?from=15-11-2026')).status).toBe(400);

    const joint = await bm.get('/visits?coWork=true');
    expect(joint.body.items).toHaveLength(3);
    expect((await bm.get(`/visits?coWorkSessionId=${sessionId}`)).body.items).toHaveLength(3);
    const single = await bm.get('/visits?coWork=false');
    expect(single.body.items.every((i: { coWork: unknown }) => i.coWork === null)).toBe(true);
    expect(single.body.items).toHaveLength(3);
    // A person's visits include the joint ones a partner recorded.
    expect((await bm.get(`/visits?userId=${s.fs1.id}&coWork=true`)).body.items).toHaveLength(3);
    expect((await bm.get(`/visits?userId=${fs3.id}&coWork=true`)).body.items).toHaveLength(0);
  });

  it('hides another branch (404) and its sessions', async () => {
    const b1 = await as(t, '01700000005');
    const other = await b1.post('/cowork/requests', { clientId: randomUUID(), toUserIds: [fsB2.id] });
    expect(other.status).toBe(201);
    const bm = await as(t, '01700000002');
    expect((await bm.get(`/cowork/sessions/${other.body.id}`)).status).toBe(404);
    expect((await bm.get(`/cowork/sessions?branchId=${s.branchB}`)).body.items).toEqual([]);
    expect((await bm.get('/cowork/sessions')).body.items.some((x: { id: string }) => x.id === other.body.id)).toBe(false);
    expect((await (await as(t, '01700000001')).get(`/cowork/sessions/${other.body.id}`)).status).toBe(200);
  });
});

describe('statistics (FR-CW-005)', () => {
  it('separates single and co-work visits and applies the credit weight', async () => {
    const bm = await as(t, '01700000002');
    const rows = async () => {
      const r = await bm.get('/reports/staff-performance?period=daily&date=2026-11-15');
      expect(r.status).toBe(200);
      expectConforms('GET', '/reports/staff-performance', 200, r.body);
      return new Map<string, Record<string, number>>(r.body.map((x: { userId: string }) => [x.userId, x]));
    };
    let by = await rows();
    expect(by.get(s.fs1.id)).toMatchObject({ visits: 2, soloVisits: 1, coWorkVisits: 2, visitCredit: 3 });
    expect(by.get(s.fs2.id)).toMatchObject({ visits: 2, soloVisits: 0, coWorkVisits: 2, visitCredit: 2, collectionsCount: 0 });
    expect(by.get(fs3.id)).toMatchObject({ visits: 2, soloVisits: 2, coWorkVisits: 0, visitCredit: 2 });
    await setSystem('cowork.visitCredit', 0.5, s.branchA);
    by = await rows();
    expect(by.get(s.fs1.id)).toMatchObject({ soloVisits: 1, coWorkVisits: 2, visitCredit: 2 });
    expect(by.get(s.fs2.id)).toMatchObject({ visitCredit: 1 });
    await setSystem('cowork.visitCredit', 1, s.branchA);
  });
});

describe('leaving and ending (FR-CW-002)', () => {
  it('work-out leaves the group, which ends when one person is left', async () => {
    t.clock.set(new Date('2026-11-15T05:00:00Z'));
    let fs1 = await as(t, '01700000003');
    const fs2 = await as(t, '01700000004');
    const out = await fs2.post('/attendance/events', { clientId: randomUUID(), type: 'work_out', at: '2026-11-15T05:00:00Z', geo: { lat: 22.7, lng: 90.37, accuracyM: 8 } });
    expect(out.status).toBe(201);
    const mine = (await fs1.get('/cowork/sessions/mine')).body[0];
    expect(mine.status).toBe('ended');
    expect(mine.endedAt).toBe('2026-11-15T05:00:00.000Z');
    expect(statusOf(mine, s.fs2.id)).toBe('left');
    const again = await fs1.post(`/cowork/sessions/${sessionId}/leave`);
    expect(again.status).toBe(200); // idempotent on an ended session
    expectConforms('POST', '/cowork/sessions/{id}/leave', 200, again.body);
    const late = await fs2.post(`/cowork/sessions/${sessionId}/respond`, { decision: 'reject' });
    expect(late.status).toBe(409);
    expect(late.body.details.reason).toBe('SESSION_ENDED');

    // A visit made while the group was together still counts when it syncs late; one made after does not.
    t.clock.set(new Date('2026-11-15T06:00:00Z'));
    fs1 = await as(t, '01700000003');
    expect((await fs1.post('/visits', visit('100246', '2026-11-15T04:45:00Z', sessionId))).body.coWork.participantIds).toEqual([s.fs2.id]);
    const after = await fs1.post('/visits', visit('100246', '2026-11-15T05:30:00Z', sessionId));
    expect(after.body.coWork).toBeNull();
    expect(after.body.flags).toContain('cowork_invalid');
  });

  it('a member can leave by hand, and midnight ends what is still open', async () => {
    const three = await as(t, '01700000007');
    const fs2 = await as(t, '01700000004');
    // fs2 declines the pending invitation by leaving; fs3 is alone, so the group is over.
    const left = await fs2.post(`/cowork/sessions/${secondId}/leave`);
    expect(statusOf(left.body, s.fs2.id)).toBe('rejected');
    expect(left.body.status).toBe('ended');

    const fresh = await three.post('/cowork/requests', { clientId: randomUUID(), toUserIds: [s.fs1.id] });
    expect(fresh.status).toBe(201);
    expect(await endPastSessions()).toBe(0); // same business day
    t.clock.set(new Date('2026-11-15T18:30:00Z')); // 00:30 Dhaka, Monday
    expect(await endPastSessions()).toBeGreaterThanOrEqual(1);
    const bm = await as(t, '01700000002');
    const ended = await bm.get(`/cowork/sessions/${fresh.body.id}`);
    expect(ended.body.status).toBe('ended');
    expect(ended.body.endedAt).toBe('2026-11-15T17:59:59.999Z');
    expect((await (await as(t, '01700000007')).get('/cowork/sessions/mine')).body).toEqual([]); // a new day starts clean
    const late = await (await as(t, '01700000003')).post(`/cowork/sessions/${fresh.body.id}/respond`, { decision: 'accept' });
    expect(late.status).toBe(409);
  });
});
