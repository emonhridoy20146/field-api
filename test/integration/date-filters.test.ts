import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { applyAssignments, getByErpId } from '../../src/modules/customers/index.js';
import { raiseInboxItem } from '../../src/modules/inbox/index.js';

// Contract 1.45.0 item 4: from / to on GET /inbox and GET /activity, the staff filters with dates, visit day and time.
let t: TestApp;
let s: Seeded;
const ids: Record<string, string> = {};
const geo = { lat: 22.7106, lng: 90.3703, accuracyM: 9 };

beforeAll(async () => {
  t = await createTestApp(); // Sunday 2026-11-15 10:00 Dhaka
  s = await seedBasics(t);
  await deltaSync();
  for (const e of ['100245', '100246', '100247']) ids[e] = (await getByErpId(e))!.id;
  await applyAssignments([
    { customerId: ids['100245']!, assigneeId: s.fs1.id },
    { customerId: ids['100246']!, assigneeId: s.fs1.id },
    { customerId: ids['100247']!, assigneeId: s.fs2.id },
  ]);
});
afterAll(async () => t.close());

describe('staff filters together with from / to', () => {
  it('visits by userId, cowork sessions by userId, promises by ownerId / createdBy (future days too), collections by collectorId', async () => {
    const fs1 = await as(t, '01700000003');
    const bm = await as(t, '01700000002');
    expect((await fs1.post('/attendance/events', { clientId: randomUUID(), type: 'work_in', at: '2026-11-15T03:00:00Z', geo })).status).toBe(201);

    // visits
    expect((await fs1.post('/visits', { clientId: randomUUID(), customerId: ids['100245'], checkInAt: '2026-11-15T03:30:00Z', outcome: 'not_home', geo })).status).toBe(201);
    const v = await bm.get(`/visits?userId=${s.fs1.id}&from=2026-11-15&to=2026-11-15`);
    expect(v.status).toBe(200);
    expect(v.body.items).toHaveLength(1);
    expect((await bm.get(`/visits?userId=${s.fs2.id}&from=2026-11-15&to=2026-11-15`)).body.items).toHaveLength(0);
    expect((await bm.get(`/visits?userId=${s.fs1.id}&from=2026-11-16&to=2026-11-20`)).body.items).toHaveLength(0);

    // co-work sessions
    const cw = await fs1.post('/cowork/requests', { clientId: randomUUID(), toUserIds: [s.fs2.id] });
    expect(cw.status).toBe(201);
    const c1 = await bm.get(`/cowork/sessions?userId=${s.fs2.id}&from=2026-11-15&to=2026-11-15`);
    expect(c1.status).toBe(200);
    expectConforms('GET', '/cowork/sessions', 200, c1.body);
    expect(c1.body.items.map((x: { id: string }) => x.id)).toEqual([cw.body.id]);
    expect((await bm.get(`/cowork/sessions?userId=${s.fs2.id}&from=2026-11-16&to=2026-11-17`)).body.items).toHaveLength(0);
    expect((await bm.get(`/cowork/sessions?userId=${s.fsB.id}&from=2026-11-15&to=2026-11-15`)).body.items).toHaveLength(0);

    // promises: "next 7 days" is from today to today + 7
    const p = await fs1.post('/promises', { clientId: randomUUID(), customerId: ids['100245'], promisedDate: '2026-11-20', promisedAmountPoisha: 100_000 });
    expect(p.status).toBe(201);
    const next7 = await bm.get(`/promises?createdBy=${s.fs1.id}&from=2026-11-15&to=2026-11-22`);
    expect(next7.status).toBe(200);
    expectConforms('GET', '/promises', 200, next7.body);
    expect(next7.body.items.map((x: { id: string }) => x.id)).toEqual([p.body.id]);
    expect((await bm.get(`/promises?ownerId=${s.fs1.id}&from=2026-11-15&to=2026-11-22`)).body.items).toHaveLength(1);
    expect((await bm.get(`/promises?createdBy=${s.fs2.id}&from=2026-11-15&to=2026-11-22`)).body.items).toHaveLength(0);
    expect((await bm.get(`/promises?ownerId=${s.fs2.id}&from=2026-11-15&to=2026-11-22`)).body.items).toHaveLength(0);
    expect((await bm.get(`/promises?createdBy=${s.fs1.id}&from=2026-11-21&to=2026-11-28`)).body.items).toHaveLength(0);

    // collections
    const col = await fs1.post('/collections', { clientId: randomUUID(), customerId: ids['100246'], amountPoisha: 150000, method: 'cash', recordedAt: '2026-11-15T03:35:00Z', receiptNo: 'BRL01-FS014-261115-0001', geo }, { 'idempotency-key': randomUUID() });
    expect(col.status).toBe(201);
    const cl = await bm.get(`/collections?collectorId=${s.fs1.id}&from=2026-11-15&to=2026-11-15`);
    expect(cl.status).toBe(200);
    expectConforms('GET', '/collections', 200, cl.body);
    expect(cl.body.items.map((x: { id: string }) => x.id)).toEqual([col.body.id]);
    expect((await bm.get(`/collections?collectorId=${s.fs2.id}&from=2026-11-15&to=2026-11-15`)).body.items).toHaveLength(0);
    expect((await bm.get(`/collections?collectorId=${s.fs1.id}&from=2026-11-16&to=2026-11-16`)).body.items).toHaveLength(0);
    expectConforms('GET', '/visits', 200, v.body);
  });
});

describe('visit rows carry the Dhaka day and time (1.45.0)', () => {
  it('businessDate and checkInLocalTime follow Asia/Dhaka across 18:00 UTC', async () => {
    t.clock.set('2026-11-15T19:00:00Z'); // 01:00 Dhaka on the 16th
    const fs2 = await as(t, '01700000004');
    const late = await fs2.post('/visits', { clientId: randomUUID(), customerId: ids['100247'], checkInAt: '2026-11-15T17:59:00Z', outcome: 'not_home', geo });
    const early = await fs2.post('/visits', { clientId: randomUUID(), customerId: ids['100247'], checkInAt: '2026-11-15T18:30:00Z', outcome: 'not_home', geo });
    expect([late.status, early.status]).toEqual([201, 201]);
    const bm = await as(t, '01700000002');
    const r = await bm.get(`/visits?userId=${s.fs2.id}`);
    const byId = new Map(r.body.items.map((x: { id: string }) => [x.id, x]));
    expect(byId.get(late.body.id)).toMatchObject({ businessDate: '2026-11-15', checkInLocalTime: '23:59' });
    expect(byId.get(early.body.id)).toMatchObject({ businessDate: '2026-11-16', checkInLocalTime: '00:30' });
    expect((await bm.get(`/visits?userId=${s.fs2.id}&date=2026-11-16`)).body.items.map((x: { id: string }) => x.id)).toEqual([early.body.id]);
    expectConforms('GET', '/visits', 200, r.body);
  });
});

describe('GET /inbox from / to (1.45.0)', () => {
  it('narrows items and counts to the Dhaka days they were raised; from after to is 400', async () => {
    t.clock.set('2026-11-15T17:59:00Z'); // 23:59 Dhaka, 15th
    await raiseInboxItem({ key: 'tag.review:df-1', type: 'tag.review', branchId: s.branchA, entity: 'customer', entityId: ids['100245']!, summary: { bn: 'ক', en: 'A' } });
    t.clock.set('2026-11-15T18:00:00Z'); // 00:00 Dhaka, 16th
    await raiseInboxItem({ key: 'tag.review:df-2', type: 'tag.review', branchId: s.branchA, entity: 'customer', entityId: ids['100246']!, summary: { bn: 'খ', en: 'B' } });
    await raiseInboxItem({ key: 'location.proposal:df-3', type: 'location.proposal', branchId: s.branchA, entity: 'customer', entityId: ids['100246']!, summary: { bn: 'গ', en: 'C' } });
    t.clock.set('2026-11-16T04:00:00Z');
    const bm = await as(t, '01700000002');
    const keyed = (body: { items: { entityId: string; type: string }[] }) => body.items.filter((i) => i.type === 'tag.review' || i.type === 'location.proposal');

    const d15 = await bm.get('/inbox?from=2026-11-15&to=2026-11-15');
    expect(d15.status).toBe(200);
    expectConforms('GET', '/inbox', 200, d15.body);
    expect(keyed(d15.body).map((i) => i.entityId)).toEqual([ids['100245']]);
    expect(d15.body.counts).toEqual({ 'tag.review': 1 });

    const d16 = await bm.get('/inbox?from=2026-11-16');
    expect(keyed(d16.body)).toHaveLength(2);
    expect(d16.body.counts['tag.review']).toBe(1);
    expect(d16.body.counts['location.proposal']).toBe(1);
    expect((await bm.get('/inbox?to=2026-11-15')).body.counts['location.proposal']).toBeUndefined();

    const all = await bm.get('/inbox');
    expect(all.body.counts['tag.review']).toBe(2);

    expect((await bm.get('/inbox?from=2026-11-16&to=2026-11-15')).status).toBe(400);
    expect((await bm.get('/inbox?from=2026-13-01')).status).toBe(400);
    expect((await (await as(t, '01700000003')).get('/inbox?from=2026-11-15')).status).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/inbox?from=2026-11-15' })).statusCode).toBe(401);
    // another branch's manager does not see them, whatever the dates
    expect(keyed((await bm.get(`/inbox?branchId=${s.branchB}&from=2026-11-15&to=2026-11-16`)).body)).toHaveLength(0);
  });
});

describe('GET /activity from / to (1.45.0)', () => {
  it('narrows the feed to the Dhaka days it happened, with the staff filter; from after to is 400', async () => {
    const visit = (id: string, userId: string) => t.ctx.bus.emit('visit.recorded', { visitId: id, customerId: ids['100245'], branchId: s.branchA, userId, outcome: 'not_home', flags: [] });
    t.clock.set('2026-11-20T17:59:00Z'); // 23:59 Dhaka, 20th
    await visit('a'.repeat(24), s.fs1.id);
    t.clock.set('2026-11-20T18:00:00Z'); // 00:00 Dhaka, 21st
    await visit('b'.repeat(24), s.fs1.id);
    await visit('c'.repeat(24), s.fs2.id);
    t.clock.set('2026-11-21T04:00:00Z');
    const bm = await as(t, '01700000002');

    const d20 = await bm.get('/activity?from=2026-11-20&to=2026-11-20');
    expect(d20.status).toBe(200);
    expectConforms('GET', '/activity', 200, d20.body);
    expect(d20.body.items.map((i: { entityId: string }) => i.entityId)).toEqual(['a'.repeat(24)]);
    expect((await bm.get('/activity?from=2026-11-21')).body.items.map((i: { entityId: string }) => i.entityId)).toEqual(['c'.repeat(24), 'b'.repeat(24)]);
    expect((await bm.get(`/activity?from=2026-11-21&to=2026-11-21&userId=${s.fs1.id}`)).body.items.map((i: { entityId: string }) => i.entityId)).toEqual(['b'.repeat(24)]);
    expect((await bm.get(`/activity?from=2026-11-20&to=2026-11-21&userId=${s.fs2.id}&type=visit`)).body.items).toHaveLength(1);
    expect((await bm.get('/activity?from=2026-11-21&to=2026-11-20')).status).toBe(400);
    expect((await (await as(t, '01700000003')).get('/activity?from=2026-11-20')).status).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/activity?from=2026-11-20' })).statusCode).toBe(401);
    // out of scope: another branch shows nothing
    expect((await bm.get(`/activity?branchId=${s.branchB}&from=2026-11-20&to=2026-11-21`)).body.items).toHaveLength(0);
  });
});
