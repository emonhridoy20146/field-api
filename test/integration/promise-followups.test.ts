import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, client, createTestApp, login, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { applyAssignments, getByErpId } from '../../src/modules/customers/index.js';
import { setSystem } from '../../src/modules/settings/index.js';
import { evaluateDue, followUpAlert } from '../../src/modules/promises/service.js';

// Contract 1.45.0 item 5 (FR-PRM-006): follow-ups of broken promises, the office's view of them and its alert.
let t: TestApp;
let s: Seeded;
const ids: Record<string, string> = {};
const DAY = 86_400_000;
type P = { id: string; status: string; followUpOf?: string; followUpId: string | null; attempt: number; chainRootId: string; closedAt: string | null };

beforeAll(async () => {
  t = await createTestApp(); // Sunday 2026-11-15 10:00 Dhaka
  s = await seedBasics(t);
  await deltaSync();
  for (const e of ['100245', '100246', '100247', '200301']) ids[e] = (await getByErpId(e))!.id;
  await applyAssignments([
    { customerId: ids['100245']!, assigneeId: s.fs1.id },
    { customerId: ids['100246']!, assigneeId: s.fs1.id },
    { customerId: ids['100247']!, assigneeId: s.fs2.id },
    { customerId: ids['200301']!, assigneeId: s.fsB.id },
  ]);
});
afterAll(async () => t.close());

const promise = (customer: string, over: Record<string, unknown> = {}) => ({ clientId: randomUUID(), customerId: ids[customer], promisedDate: '2026-11-15', promisedAmountPoisha: 100_000, ...over });
const byId = async (c: ReturnType<typeof client>, customer: string, id: string): Promise<P> => (await c.get(`/promises?customerId=${ids[customer]}`)).body.items.find((p: P) => p.id === id);

let p1 = ''; // 100245, broken on the 17th
let p2 = ''; // 100246, broken on the 17th, nobody follows it up
let f1 = ''; // follow-up of p1

describe('follow-up promises (FR-PRM-006)', () => {
  it('a first promise is attempt 1 and its own chain root; broken promises keep their status', async () => {
    const fs1 = await as(t, '01700000003');
    const a = await fs1.post('/promises', promise('100245'));
    expect(a.status).toBe(201);
    expectConforms('POST', '/promises', 201, a.body);
    expect(a.body).toMatchObject({ attempt: 1, chainRootId: a.body.id, followUpId: null, closedAt: null });
    expect(a.body.followUpOf).toBeUndefined();
    p1 = a.body.id;
    p2 = (await fs1.post('/promises', promise('100246'))).body.id;

    // not broken yet
    const early = await fs1.post('/promises', promise('100245', { promisedDate: '2026-11-20', followUpOf: p1 }));
    expect(early.status).toBe(422);
    expect(early.body.details).toMatchObject({ rule: 'PROMISE_FOLLOW_UP_INVALID', reason: 'NOT_BROKEN' });

    t.clock.advance(2 * DAY); // 17th: promised 15th + 1 grace day is over, nothing paid
    expect(await evaluateDue()).toBe(2);
    const bm = await as(t, '01700000002');
    expect(await byId(bm, '100245', p1)).toMatchObject({ status: 'broken', followUpId: null, closedAt: '2026-11-17T04:00:00.000Z' });
  });

  it('refuses a follow-up of an unknown, out-of-scope or other customer\'s promise (422)', async () => {
    const fs1 = await as(t, '01700000003');
    const reason = async (c: ReturnType<typeof client>, body: Record<string, unknown>) => {
      const r = await c.post('/promises', body);
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('BUSINESS_RULE');
      return r.body.details.reason as string;
    };
    expect(await reason(fs1, promise('100245', { promisedDate: '2026-11-20', followUpOf: 'f'.repeat(24) }))).toBe('NOT_FOUND');
    expect(await reason(fs1, promise('100245', { promisedDate: '2026-11-20', followUpOf: 'not-an-id' }))).toBe('NOT_FOUND');
    expect(await reason(fs1, promise('100246', { promisedDate: '2026-11-20', followUpOf: p1 }))).toBe('OTHER_CUSTOMER');
    // branch B staff cannot see branch A's promise
    expect(await reason(await as(t, '01700000005'), promise('200301', { promisedDate: '2026-11-20', followUpOf: p1 }))).toBe('NOT_FOUND');
    expect((await (await as(t, '01700000006')).post('/promises', promise('100245', { promisedDate: '2026-11-20', followUpOf: p1 }))).status).toBe(403);
    expect((await client(t.app).post('/promises', promise('100245', { promisedDate: '2026-11-20', followUpOf: p1 }))).status).toBe(401);
  });

  it('links the follow-up: attempt 2, same chain, the broken promise points at it; idempotent by clientId', async () => {
    const fs1 = await as(t, '01700000003');
    const body = promise('100245', { promisedDate: '2026-11-17', followUpOf: p1 });
    const r = await fs1.post('/promises', body);
    expect(r.status).toBe(201);
    expectConforms('POST', '/promises', 201, r.body);
    expect(r.body).toMatchObject({ followUpOf: p1, attempt: 2, chainRootId: p1, status: 'open', followUpId: null });
    f1 = r.body.id;
    const replay = await fs1.post('/promises', body);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(f1);

    const bm = await as(t, '01700000002');
    expect(await byId(bm, '100245', p1)).toMatchObject({ status: 'broken', followUpId: f1 });
    const kids = await bm.get(`/promises?followUpOf=${p1}`);
    expectConforms('GET', '/promises', 200, kids.body);
    expect(kids.body.items.map((p: P) => p.id)).toEqual([f1]);

    // the office: broken promises nobody followed up
    const open = await bm.get('/promises?brokenWithoutFollowUp=true');
    expect(open.status).toBe(200);
    expectConforms('GET', '/promises', 200, open.body);
    expect(open.body.items.map((p: P) => p.id)).toEqual([p2]);
    expect((await bm.get('/promises?brokenWithoutFollowUp=true&status=partially_kept')).body.items).toEqual([]);
    expect((await bm.get(`/promises?brokenWithoutFollowUp=true&createdBy=${s.fs2.id}`)).body.items).toEqual([]);
    expect((await bm.get(`/promises?brokenWithoutFollowUp=true&createdBy=${s.fs1.id}`)).body.items).toHaveLength(1);
    expect((await bm.get('/promises?brokenWithoutFollowUp=false')).body.items.length).toBeGreaterThan(1);
    expect((await bm.get('/promises?brokenWithoutFollowUp=yes')).status).toBe(400);
    // out of scope: another branch's staff see none of them
    expect((await (await as(t, '01700000005')).get(`/promises?followUpOf=${p1}`)).body.items).toEqual([]);
  });

  it('the sync mutation takes followUpOf too: attempt 3 of the same chain', async () => {
    t.clock.advance(2 * DAY); // 19th: f1 (due 17th) is judged broken
    expect(await evaluateDue()).toBe(1);
    const fs1 = await as(t, '01700000003');
    const clientId = randomUUID();
    const r = await fs1.post('/sync/push', { deviceId: 'dev-01700000003', mutations: [{ mutationId: randomUUID(), entity: 'promise', op: 'create', payload: promise('100245', { clientId, promisedDate: '2026-11-22', followUpOf: f1 }) }] });
    expect(r.status).toBe(200);
    expect(r.body.results[0].result).toBe('applied');
    const f2 = r.body.results[0].entityId as string;
    expect(await byId(fs1, '100245', f2)).toMatchObject({ followUpOf: f1, attempt: 3, chainRootId: p1 });
    expect(await byId(fs1, '100245', f1)).toMatchObject({ status: 'broken', followUpId: f2 });
    const bad = await fs1.post('/sync/push', { deviceId: 'dev-01700000003', mutations: [{ mutationId: randomUUID(), entity: 'promise', op: 'create', payload: promise('100246', { promisedDate: '2026-11-22', followUpOf: f1 }) }] });
    expect(bad.body.results[0]).toMatchObject({ result: 'rejected', error: { code: 'BUSINESS_RULE' } });

    // customer detail draws the chain, newest first
    const d = await (await as(t, '01700000002')).get(`/customers/${ids['100245']}`);
    expect(d.status).toBe(200);
    expectConforms('GET', '/customers/{id}', 200, d.body);
    expect(d.body.recentPromises.map((p: P) => [p.id, p.attempt, p.status])).toEqual([
      [f2, 3, 'open'],
      [f1, 2, 'broken'],
      [p1, 1, 'broken'],
    ]);

    // cancelling the follow-up: the broken promise has no follow-up again
    const c = await fs1.post(`/promises/${f2}/cancel`, { reason: 'Customer moved away' });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ status: 'cancelled', followUpOf: f1 });
    expect(c.body.closedAt).toBe('2026-11-19T04:00:00.000Z');
    expect(await byId(fs1, '100245', f1)).toMatchObject({ followUpId: null });
    expect((await fs1.get('/promises?brokenWithoutFollowUp=true')).body.items.map((p: P) => p.id)).toEqual([f1, p2]);
    // out of scope cancel is 404
    expect((await (await as(t, '01700000005')).post(`/promises/${f1}/cancel`, { reason: 'Not mine at all' })).status).toBe(404);
  });

  it('alerts the office once when nobody followed up within promises.followUpAlertDays, and resolves it on a follow-up', async () => {
    const events: Record<string, unknown>[] = [];
    t.ctx.bus.on('promise.follow_up_overdue', async (p) => void events.push(p as Record<string, unknown>));
    // 19th: p2 closed on the 17th (2 days), f1 closed today (0 days)
    expect(await followUpAlert()).toBe(1);
    expect(events).toEqual([expect.objectContaining({ promiseId: p2, customerId: ids['100246'], branchId: s.branchA, days: 2 })]);
    expect(await followUpAlert()).toBe(0); // once per promise
    const bm = await as(t, '01700000002');
    const inbox = await bm.get('/inbox?type=promise.no_follow_up');
    expect(inbox.status).toBe(200);
    expectConforms('GET', '/inbox', 200, inbox.body);
    expect(inbox.body.items).toEqual([expect.objectContaining({ entity: 'promise', entityId: p2, severity: 'medium', status: 'open' })]);
    expect(inbox.body.counts['promise.no_follow_up']).toBe(1);

    // a branch override makes f1 due at once
    await setSystem('promises.followUpAlertDays', 0, s.branchA);
    expect(await followUpAlert()).toBe(1);
    await setSystem('promises.followUpAlertDays', 2, s.branchA);

    // the follow-up closes the item
    const fs1 = await as(t, '01700000003');
    expect((await fs1.post('/promises', promise('100246', { promisedDate: '2026-11-21', followUpOf: p2 }))).status).toBe(201);
    expect((await bm.get('/inbox?type=promise.no_follow_up')).body.items.map((i: { entityId: string }) => i.entityId)).toEqual([f1]);
    expect((await bm.get('/inbox?type=promise.no_follow_up&status=resolved')).body.items.map((i: { entityId: string }) => i.entityId)).toEqual([p2]);
    expect(await followUpAlert()).toBe(0);
  });

  it('a promise recorded from admin-web is audited; one from the app is not', async () => {
    const web = await login(t.app, '01700000002', { client: 'web' });
    const bmWeb = client(t.app, web.accessToken);
    const r = await bmWeb.post('/promises', promise('100247', { promisedDate: '2026-11-25' }));
    expect(r.status).toBe(201);
    const fromApp = await (await as(t, '01700000004')).post('/promises', promise('100247', { promisedDate: '2026-11-26' }));
    expect(fromApp.status).toBe(201);
    const log = await (await as(t, '01700000001')).get('/audit?action=promise.created');
    expect(log.status).toBe(200);
    expect(log.body.items.map((a: { entityId: string }) => a.entityId)).toEqual([r.body.id]);
    expect(log.body.items[0]).toMatchObject({ actor: { id: s.bm.id }, branchId: s.branchA });
  });
});
