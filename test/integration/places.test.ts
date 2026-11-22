import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { setFlagSystem } from '../../src/modules/flags/index.js';
import { AuditLogModel } from '../../src/modules/audit/models/audit-log.model.js';

let t: TestApp;
let s: Seeded;
const FS1 = '01700000003';
const FS2 = '01700000004';
const FSB = '01700000005';
const BM = '01700000002';
const SA = '01700000001';
const VW = '01700000006';
const bazaar = { lat: 22.7012, lng: 90.3711 };
const north = { lat: 22.7022, lng: 90.3711 }; // ~111 m north
const mut = (entity: string, payload: Record<string, unknown>) => ({ mutationId: randomUUID(), entity, op: 'create', payload });
const types = (body: { items: { type: string }[] }) => body.items.map((i) => i.type);
const newPlace = (over: Record<string, unknown> = {}) => ({ clientId: randomUUID(), name: 'Karim Store', icon: 'shop', note: 'Blue gate, next to the tea stall', location: bazaar, ...over });
let placeId = '';

beforeAll(async () => {
  t = await createTestApp(); // 2026-11-15 10:00 Dhaka
  s = await seedBasics(t);
});
afterAll(async () => t.close());

describe('adding a place (FR-PLC-001/002)', () => {
  it('field staff add a place; it is active at once; a repeat of the clientId is a replay', async () => {
    const fs1 = await as(t, FS1);
    const body = newPlace();
    const r = await fs1.post('/places', body);
    expect(r.status).toBe(201);
    expectConforms('POST', '/places', 201, r.body);
    placeId = r.body.id;
    expect(r.body).toMatchObject({ clientId: body.clientId, branchId: s.branchA, name: 'Karim Store', icon: 'shop', note: body.note, location: bazaar, status: 'active', version: 1, pendingMove: null, lastMoveDecision: null });
    expect(r.body.createdBy).toEqual({ id: s.fs1.id, name: 'Rakib Hasan' });
    expect(r.body.events.map((e: { type: string }) => e.type)).toEqual(['created']);

    const again = await fs1.post('/places', body);
    expect(again.status).toBe(200);
    expectConforms('POST', '/places', 200, again.body);
    expect(again.body.id).toBe(placeId);
  });

  it('401 without a token, 400 for bad input, 422 outside Bangladesh or another branch, 403 for the viewer', async () => {
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/places', payload: newPlace() })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/places' })).statusCode).toBe(401);
    const fs1 = await as(t, FS1);
    expect((await fs1.post('/places', newPlace({ name: 'x'.repeat(61) }))).status).toBe(400);
    expect((await fs1.post('/places', newPlace({ name: '   ' }))).status).toBe(400);
    expect((await fs1.post('/places', newPlace({ icon: 'castle' }))).status).toBe(400);
    expect((await fs1.post('/places', newPlace({ note: 'n'.repeat(201) }))).status).toBe(400);
    expect((await fs1.post('/places', { ...newPlace(), clientId: 'not-a-uuid' })).status).toBe(400);
    const abroad = await fs1.post('/places', newPlace({ location: { lat: 51.5, lng: -0.12 } }));
    expect(abroad.status).toBe(422);
    expect(abroad.body.details.rule).toBe('OUTSIDE_BANGLADESH');
    expect((await fs1.post('/places', newPlace({ branchId: s.branchB }))).body.details.rule).toBe('PLACE_INVALID_BRANCH');
    expect((await (await as(t, VW)).post('/places', newPlace())).status).toBe(403);
  });

  it('the office may put a place in any branch it can see', async () => {
    const r = await (await as(t, SA)).post('/places', newPlace({ name: 'Patuakhali Bus Stand', icon: 'bus_stop', branchId: s.branchB, location: { lat: 22.3596, lng: 90.3299 }, note: undefined }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ branchId: s.branchB, note: null });
  });
});

describe('who sees a place (scope)', () => {
  it('the branch sees it; another branch does not (404); the viewer sees it; super admin sees all', async () => {
    const fs2 = await as(t, FS2);
    const list = await fs2.get('/places');
    expect(list.status).toBe(200);
    expectConforms('GET', '/places', 200, list.body);
    expect(list.body.items.map((p: { name: string }) => p.name)).toEqual(['Karim Store']);
    expectConforms('GET', '/places/{id}', 200, (await fs2.get(`/places/${placeId}`)).body);

    const fsB = await as(t, FSB);
    expect((await fsB.get('/places')).body.items.map((p: { name: string }) => p.name)).toEqual(['Patuakhali Bus Stand']);
    expect((await fsB.get(`/places/${placeId}`)).status).toBe(404);
    expect((await fsB.get('/places/not-an-id')).status).toBe(404);
    expect((await fsB.get(`/places?branchId=${s.branchA}`)).body.items).toHaveLength(0);

    expect((await (await as(t, VW)).get('/places')).body.items).toHaveLength(1);
    expect((await (await as(t, SA)).get('/places')).body.items).toHaveLength(2);
  });

  it('filters: words, icon, map area', async () => {
    const sa = await as(t, SA);
    expect((await sa.get('/places?q=karim')).body.items.map((p: { name: string }) => p.name)).toEqual(['Karim Store']);
    expect((await sa.get('/places?q=tea stall')).body.items).toHaveLength(1);
    expect((await sa.get('/places?icon=bus_stop')).body.items.map((p: { name: string }) => p.name)).toEqual(['Patuakhali Bus Stand']);
    expect((await sa.get('/places?bbox=90.36,22.69,90.38,22.71')).body.items.map((p: { name: string }) => p.name)).toEqual(['Karim Store']);
    expect((await sa.get('/places?bbox=1,2,3')).status).toBe(400);
    const page = await sa.get('/places?limit=1');
    expect(page.body.items).toHaveLength(1);
    expect((await sa.get(`/places?limit=1&cursor=${encodeURIComponent(page.body.nextCursor)}`)).body.items).toHaveLength(1);
  });
});

describe('changing a place (FR-PLC-003)', () => {
  it('the creator changes words and icon; nothing new changes nothing', async () => {
    const fs1 = await as(t, FS1);
    const r = await fs1.patch(`/places/${placeId}`, { name: 'Karim General Store', icon: 'shop' });
    expect(r.status).toBe(200);
    expectConforms('PATCH', '/places/{id}', 200, r.body);
    expect(r.body).toMatchObject({ name: 'Karim General Store', version: 2, updatedBy: { id: s.fs1.id } });
    const same = await fs1.patch(`/places/${placeId}`, { name: 'Karim General Store' });
    expect(same.body.version).toBe(2);
    expect((await fs1.patch(`/places/${placeId}`, {})).status).toBe(400);
  });

  it('others need place.manage (403); staff cannot move directly (403); a stale If-Match is 412', async () => {
    const fs2 = await as(t, FS2);
    const other = await fs2.patch(`/places/${placeId}`, { name: 'Mine now' });
    expect(other.status).toBe(403);
    expect(other.body.details.reason).toBe('NOT_OWNER');
    expect((await (await as(t, FS1)).patch(`/places/${placeId}`, { location: north })).body.details.reason).toBe('MOVE_NEEDS_MANAGE');
    expect((await (await as(t, FSB)).patch(`/places/${placeId}`, { name: 'x' })).status).toBe(404);
    expect((await (await as(t, VW)).patch(`/places/${placeId}`, { name: 'x' })).status).toBe(403);
    expect((await (await as(t, BM)).patch(`/places/${placeId}`, { note: null }, { 'if-match': 'W/"1"' })).status).toBe(412);
  });

  it('the office changes any place and moves it directly', async () => {
    const bm = await as(t, BM);
    const r = await bm.patch(`/places/${placeId}`, { note: null }, { 'if-match': 'W/"2"' });
    expect(r.body).toMatchObject({ note: null, version: 3 });
    const moved = await bm.patch(`/places/${placeId}`, { location: { lat: 22.7013, lng: 90.3712 } });
    expect(moved.body).toMatchObject({ location: { lat: 22.7013, lng: 90.3712 }, version: 4 });
    expect(moved.body.events.at(-1)).toMatchObject({ type: 'moved', from: bazaar, to: { lat: 22.7013, lng: 90.3712 } });
    expect((await bm.patch(`/places/${placeId}`, { location: { lat: 40, lng: 90 } })).body.details.rule).toBe('OUTSIDE_BANGLADESH');
  });
});

describe('move requests (FR-PLC-004/005)', () => {
  let clientId = '';
  it('any staff member of the branch asks; the marker stays; the office gets an inbox item and a notification', async () => {
    const fs2 = await as(t, FS2);
    clientId = randomUUID();
    const r = await fs2.post(`/places/${placeId}/move-request`, { clientId, location: north, reason: 'The shop is across the road' });
    expect(r.status).toBe(201);
    expectConforms('POST', '/places/{id}/move-request', 201, r.body);
    expect(r.body.location).toEqual({ lat: 22.7013, lng: 90.3712 });
    expect(r.body.pendingMove).toMatchObject({ location: north, requestedBy: { id: s.fs2.id, name: 'Sumon Mia' }, reason: 'The shop is across the road' });
    expect(r.body.pendingMove.distanceM).toBeGreaterThan(90);

    const again = await fs2.post(`/places/${placeId}/move-request`, { clientId, location: north });
    expect(again.status).toBe(200);
    expectConforms('POST', '/places/{id}/move-request', 200, again.body);

    const bm = await as(t, BM);
    expect(types((await bm.get('/notifications')).body)).toContain('place.move_request');
    const inbox = await bm.get('/inbox');
    expect(inbox.body.items.find((i: { type: string }) => i.type === 'place.move_request').link).toBe('/places/move-requests');
    const queue = await bm.get('/places/move-requests');
    expectConforms('GET', '/places/move-requests', 200, queue.body);
    expect(queue.body.items.map((p: { id: string }) => p.id)).toEqual([placeId]);
    expect((await bm.get('/places?pendingMove=true')).body.items).toHaveLength(1);
  });

  it('one open request per place (409), 404 out of scope, 422 too short, 403 queue for staff, 400 bad body', async () => {
    const fs1 = await as(t, FS1);
    const second = await fs1.post(`/places/${placeId}/move-request`, { clientId: randomUUID(), location: north });
    expect(second.status).toBe(409);
    expect(second.body.details.reason).toBe('MOVE_PENDING');
    expect((await (await as(t, FSB)).post(`/places/${placeId}/move-request`, { clientId: randomUUID(), location: north })).status).toBe(404);
    expect((await fs1.post(`/places/${placeId}/move-request`, { location: north })).status).toBe(400);
    expect((await fs1.get('/places/move-requests')).status).toBe(403);
    expect((await fs1.post(`/places/${placeId}/move-request/decision`, { decision: 'approve' })).status).toBe(403);
  });

  it('the office rejects with a reason; the requester is told; the inbox item closes', async () => {
    const bm = await as(t, BM);
    expect((await bm.post(`/places/${placeId}/move-request/decision`, { decision: 'reject', reason: 'no' })).body.details.rule).toBe('REASON_REQUIRED');
    const r = await bm.post(`/places/${placeId}/move-request/decision`, { decision: 'reject', reason: 'The gate is on this side' });
    expect(r.status).toBe(200);
    expectConforms('POST', '/places/{id}/move-request/decision', 200, r.body);
    expect(r.body).toMatchObject({ pendingMove: null, location: { lat: 22.7013, lng: 90.3712 }, lastMoveDecision: { decision: 'reject', reason: 'The gate is on this side', by: { id: s.bm.id }, requestedBy: { id: s.fs2.id } } });
    expect(types((await (await as(t, FS2)).get('/notifications')).body)).toContain('place.move_decided');
    expect(types((await bm.get('/inbox')).body)).not.toContain('place.move_request');
    expect((await bm.post(`/places/${placeId}/move-request/decision`, { decision: 'approve' })).body.details.reason).toBe('NO_PENDING_MOVE');
    // The same request sent again (an offline retry after the decision) is a replay, not a new request.
    expect((await (await as(t, FS2)).post(`/places/${placeId}/move-request`, { clientId, location: north })).status).toBe(200);
    expect((await bm.get('/places/move-requests')).body.items).toHaveLength(0);
  });

  it('approved, the marker moves to the requested point', async () => {
    const fs1 = await as(t, FS1);
    expect((await fs1.post(`/places/${placeId}/move-request`, { clientId: randomUUID(), location: { lat: 22.7013, lng: 90.37121 } })).body.details.rule).toBe('MOVE_TOO_SHORT');
    expect((await fs1.post(`/places/${placeId}/move-request`, { clientId: randomUUID(), location: north })).status).toBe(201);
    const r = await (await as(t, BM)).post(`/places/${placeId}/move-request/decision`, { decision: 'approve' });
    expect(r.body).toMatchObject({ location: north, pendingMove: null, lastMoveDecision: { decision: 'approve', requestedBy: { id: s.fs1.id } } });
    expect(r.body.events.map((e: { type: string }) => e.type)).toEqual(['created', 'edited', 'edited', 'moved', 'move_requested', 'move_rejected', 'move_requested', 'move_approved']);
  });
});

describe('offline (sync mutations and entity `place`)', () => {
  it('create, edit by placeClientId and move request work through /sync/push; the branch pulls the place', async () => {
    const fs1 = await as(t, FS1);
    const created = newPlace({ name: 'Baitul Aman Mosque', icon: 'mosque' });
    const push = await fs1.post('/sync/push', {
      deviceId: `dev-${FS1}`,
      mutations: [mut('place', created), mut('place_edit', { placeClientId: created.clientId, note: 'Big white dome' }), mut('place_edit', { placeClientId: created.clientId, location: north })],
    });
    expect(push.status).toBe(200);
    expectConforms('POST', '/sync/push', 200, push.body);
    const [a, b, c] = push.body.results;
    expect(a).toMatchObject({ result: 'applied' });
    expect(b).toMatchObject({ result: 'applied', entityId: a.entityId });
    expect(c.result).toBe('rejected'); // a direct move is not an offline staff action
    const moveId = randomUUID();
    const fs2 = await as(t, FS2);
    const req = await fs2.post('/sync/push', { deviceId: `dev-${FS2}`, mutations: [mut('place_move_request', { placeId: a.entityId, clientId: moveId, location: { lat: 22.705, lng: 90.375 } })] });
    expect(req.body.results[0]).toMatchObject({ result: 'applied', status: 'pending' });

    const pull = await fs2.get('/sync/pull?cursor=s_0');
    expectConforms('GET', '/sync/pull', 200, pull.body);
    const change = pull.body.changes.find((x: { entity: string; id: string }) => x.entity === 'place' && x.id === a.entityId);
    expect(change.data).toMatchObject({ name: 'Baitul Aman Mosque', note: 'Big white dome', clientId: created.clientId, pendingMove: { requestedBy: { id: s.fs2.id } } });
    const boot = await fs2.get('/sync/bootstrap');
    expect(boot.body.items.filter((i: { entity: string }) => i.entity === 'place').map((i: { data: { name: string } }) => i.data.name).sort()).toEqual(['Baitul Aman Mosque', 'Karim General Store']);
    // Branch B never receives branch A's places.
    const fsB = await as(t, FSB);
    expect((await fsB.get('/sync/bootstrap')).body.items.filter((i: { entity: string }) => i.entity === 'place').map((i: { data: { name: string } }) => i.data.name)).toEqual(['Patuakhali Bus Stand']);
  });
});

describe('deleting a place (FR-PLC-006)', () => {
  it('only the office deletes; soft delete; staff lose it (404, tombstone); the office still sees it', async () => {
    expect((await (await as(t, FS1)).delete(`/places/${placeId}`)).status).toBe(403);
    const bm = await as(t, BM);
    const r = await bm.delete(`/places/${placeId}?reason=${encodeURIComponent('Shop closed down')}`);
    expect(r.status).toBe(200);
    expectConforms('DELETE', '/places/{id}', 200, r.body);
    expect(r.body).toMatchObject({ status: 'deleted', deleteReason: 'Shop closed down' });
    expect((await bm.delete(`/places/${placeId}`)).body.status).toBe('deleted');
    const fs2 = await as(t, FS2);
    expect((await fs2.get(`/places/${placeId}`)).status).toBe(404);
    expect((await fs2.patch(`/places/${placeId}`, { name: 'x' })).status).toBe(404);
    expect((await fs2.post(`/places/${placeId}/move-request`, { clientId: randomUUID(), location: bazaar })).status).toBe(404);
    expect((await fs2.get('/places?status=deleted')).status).toBe(403);
    expect((await bm.get(`/places/${placeId}`)).body.status).toBe('deleted');
    expect((await bm.get('/places?status=deleted')).body.items.map((p: { id: string }) => p.id)).toEqual([placeId]);
    expect((await bm.patch(`/places/${placeId}`, { name: 'x' })).body.details.reason).toBe('PLACE_DELETED');
    const pull = await fs2.get('/sync/pull?cursor=s_0');
    expect(pull.body.changes.find((x: { entity: string; id: string }) => x.entity === 'place' && x.id === placeId)).toMatchObject({ op: 'delete', reason: 'deleted' });
  });

  it('every step is audited', async () => {
    const actions = (await AuditLogModel.find({ entity: 'place', entityId: placeId }).sort({ _id: 1 }).lean()).map((a) => a.action);
    expect(actions).toEqual(['place.created', 'place.edited', 'place.edited', 'place.moved', 'place.move_requested', 'place.move_rejected', 'place.move_requested', 'place.move_approved', 'place.deleted']);
  });
});

describe('module flag', () => {
  it('off by default: the routes and mutations answer FEATURE_DISABLED', async () => {
    await setFlagSystem('module.places', false);
    const fs1 = await as(t, FS1);
    const r = await fs1.get('/places');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('FEATURE_DISABLED');
    const push = await fs1.post('/sync/push', { deviceId: `dev-${FS1}`, mutations: [mut('place', newPlace())] });
    expect(push.body.results[0].error.code).toBe('FEATURE_DISABLED');
    await setFlagSystem('module.places', true);
  });
});
