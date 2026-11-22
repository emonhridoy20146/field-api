import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, createTestApp, PASSWORD, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { setFlagSystem } from '../../src/modules/flags/index.js';
import { AuditLogModel } from '../../src/modules/audit/models/audit-log.model.js';
import { createSystemUser } from '../../src/modules/users/index.js';

let t: TestApp;
let s: Seeded;
const FS1 = '01700000003';
const FS2 = '01700000004';
const FSB = '01700000005';
const BM = '01700000002';
const SA = '01700000001';
const VW = '01700000006';
const BMB = '01700000009'; // manager of branch B only
const SA0 = '01700000010'; // super admin without a branch
const bazaar = { lat: 22.7012, lng: 90.3711 };
const north = { lat: 22.7022, lng: 90.3711 }; // ~111 m north
const mut = (entity: string, payload: Record<string, unknown>) => ({ mutationId: randomUUID(), entity, op: 'create', payload });
const types = (body: { items: { type: string }[] }) => body.items.map((i) => i.type);
const newPlace = (over: Record<string, unknown> = {}) => ({ clientId: randomUUID(), name: 'Karim Store', icon: 'shop', note: 'Blue gate, next to the tea stall', location: bazaar, ...over });
let placeId = '';
let bmB: { id: string };

beforeAll(async () => {
  t = await createTestApp(); // 2026-11-15 10:00 Dhaka
  s = await seedBasics(t);
  const mk = (role: 'branch_manager' | 'super_admin', phone: string, code: string, branchIds: string[], en: string) =>
    createSystemUser({ name: { en, bn: en }, phone, role, branchIds, employeeCode: code, password: PASSWORD });
  bmB = await mk('branch_manager', BMB, 'BM101', [s.branchB], 'Manager B');
  await mk('super_admin', SA0, 'SA002', [], 'Owner Two');
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

  it('401 without a token, 400 for bad input, 422 outside Bangladesh, 403 for the viewer', async () => {
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
    expect((await (await as(t, VW)).post('/places', newPlace())).status).toBe(403);
  });

  it('no branch is needed (ADR-054): a branchId in the body is ignored; the adder\'s branch is kept for the record', async () => {
    const r = await (await as(t, FSB)).post('/places', newPlace({ name: 'Patuakhali Bus Stand', icon: 'bus_stop', branchId: s.branchA, location: { lat: 22.3596, lng: 90.3299 }, note: undefined }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ branchId: s.branchB, note: null });
    // Someone with no branch at all adds a place too (it was PLACE_INVALID_BRANCH before 1.42.0).
    const none = await (await as(t, SA0)).post('/places', newPlace({ name: 'Galachipa Launch Ghat', icon: 'landmark', branchId: 'not-a-branch', location: { lat: 22.164, lng: 90.426 } }));
    expect(none.status).toBe(201);
    expectConforms('POST', '/places', 201, none.body);
    expect(none.body.branchId).toBe('');
    expect((await AuditLogModel.findOne({ entity: 'place', entityId: none.body.id, action: 'place.created' }).lean())?.branchId).toBeNull();
    // Removed again so the lists below stay small; it is not part of the story.
    expect((await (await as(t, SA)).delete(`/places/${none.body.id}`)).status).toBe(200);
  });
});

describe('who sees a place (ADR-054: every branch)', () => {
  it('every branch sees every place, in the list and by id; branchId only narrows; the viewer sees them all too', async () => {
    const both = ['Patuakhali Bus Stand', 'Karim Store'];
    const fs2 = await as(t, FS2);
    const list = await fs2.get('/places');
    expect(list.status).toBe(200);
    expectConforms('GET', '/places', 200, list.body);
    expect(list.body.items.map((p: { name: string }) => p.name)).toEqual(both);
    expectConforms('GET', '/places/{id}', 200, (await fs2.get(`/places/${placeId}`)).body);

    const fsB = await as(t, FSB);
    expect((await fsB.get('/places')).body.items.map((p: { name: string }) => p.name)).toEqual(both);
    expect((await fsB.get(`/places/${placeId}`)).body.name).toBe('Karim Store');
    expect((await fsB.get('/places/not-an-id')).status).toBe(404);
    expect((await fsB.get(`/places?branchId=${s.branchA}`)).body.items.map((p: { name: string }) => p.name)).toEqual(['Karim Store']);

    expect((await (await as(t, VW)).get('/places')).body.items).toHaveLength(2);
    expect((await (await as(t, SA)).get('/places')).body.items).toHaveLength(2);
    expect((await (await as(t, SA0)).get('/places')).body.items).toHaveLength(2);
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
    // Another branch's staff see the place but it is not theirs to edit.
    expect((await (await as(t, FSB)).patch(`/places/${placeId}`, { name: 'x' })).body.details.reason).toBe('NOT_OWNER');
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

  it('one open request per place (409, also from another branch), 422 too short, 403 queue for staff, 400 bad body', async () => {
    const fs1 = await as(t, FS1);
    const second = await fs1.post(`/places/${placeId}/move-request`, { clientId: randomUUID(), location: north });
    expect(second.status).toBe(409);
    expect(second.body.details.reason).toBe('MOVE_PENDING');
    expect((await (await as(t, FSB)).post(`/places/${placeId}/move-request`, { clientId: randomUUID(), location: north })).body.details.reason).toBe('MOVE_PENDING');
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
  it('create, edit by placeClientId and move request work through /sync/push; every branch pulls the place', async () => {
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
    expect(c.result).toBe('rejected'); // a direct move is not a staff action, offline either (1.43.0: FORBIDDEN)
    expect(c.error).toMatchObject({ code: 'FORBIDDEN', details: { reason: 'MOVE_NEEDS_MANAGE' } });
    const moveId = randomUUID();
    const fs2 = await as(t, FS2);
    const req = await fs2.post('/sync/push', { deviceId: `dev-${FS2}`, mutations: [mut('place_move_request', { placeId: a.entityId, clientId: moveId, location: { lat: 22.705, lng: 90.375 } })] });
    expect(req.body.results[0]).toMatchObject({ result: 'applied', status: 'pending' });

    const pull = await fs2.get('/sync/pull?cursor=s_0');
    expectConforms('GET', '/sync/pull', 200, pull.body);
    const change = pull.body.changes.find((x: { entity: string; id: string }) => x.entity === 'place' && x.id === a.entityId);
    expect(change.data).toMatchObject({ name: 'Baitul Aman Mosque', note: 'Big white dome', clientId: created.clientId, pendingMove: { requestedBy: { id: s.fs2.id } } });
    const boot = await fs2.get('/sync/bootstrap');
    const all = ['Baitul Aman Mosque', 'Karim General Store', 'Patuakhali Bus Stand'];
    expect(boot.body.items.filter((i: { entity: string }) => i.entity === 'place').map((i: { data: { name: string } }) => i.data.name).sort()).toEqual(all);
    // ADR-054: branch B receives branch A's places too, in the snapshot and in the change feed.
    const fsB = await as(t, FSB);
    expect((await fsB.get('/sync/bootstrap')).body.items.filter((i: { entity: string }) => i.entity === 'place').map((i: { data: { name: string } }) => i.data.name).sort()).toEqual(all);
    const pullB = await fsB.get('/sync/pull?cursor=s_0');
    expect(pullB.body.changes.find((x: { entity: string; id: string }) => x.entity === 'place' && x.id === a.entityId)?.data).toMatchObject({ name: 'Baitul Aman Mosque' });
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
    expect((await bm.get('/places?status=deleted')).body.items.map((p: { id: string }) => p.id)).toContain(placeId);
    expect((await bm.patch(`/places/${placeId}`, { name: 'x' })).body.details.reason).toBe('PLACE_DELETED');
    const pull = await fs2.get('/sync/pull?cursor=s_0');
    expect(pull.body.changes.find((x: { entity: string; id: string }) => x.entity === 'place' && x.id === placeId)).toMatchObject({ op: 'delete', reason: 'deleted' });
  });

  it('every step is audited', async () => {
    const actions = (await AuditLogModel.find({ entity: 'place', entityId: placeId }).sort({ _id: 1 }).lean()).map((a) => a.action);
    expect(actions).toEqual(['place.created', 'place.edited', 'place.edited', 'place.moved', 'place.move_requested', 'place.move_rejected', 'place.move_requested', 'place.move_approved', 'place.deleted']);
  });
});

describe('the office of any branch (ADR-054)', () => {
  it('a manager of another branch moves, edits and removes a place, and decides its move requests', async () => {
    const fs1 = await as(t, FS1);
    const created = await fs1.post('/places', newPlace({ name: 'Old Ghat', icon: 'landmark', location: { lat: 22.71, lng: 90.38 } }));
    expect(created.body.branchId).toBe(s.branchA);
    const id = created.body.id as string;
    const bmb = await as(t, BMB);

    const moved = await bmb.patch(`/places/${id}`, { location: { lat: 22.711, lng: 90.38 }, name: 'Old Launch Ghat' });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ name: 'Old Launch Ghat', location: { lat: 22.711, lng: 90.38 }, updatedBy: { id: bmB.id } });

    // A staff member of branch B asks to move branch A's place: both offices are told and see it in the inbox and the queue.
    const clientId = randomUUID();
    const req = await (await as(t, FSB)).post(`/places/${id}/move-request`, { clientId, location: { lat: 22.712, lng: 90.38 } });
    expect(req.status).toBe(201);
    const bm = await as(t, BM);
    for (const office of [bm, bmb]) {
      expect(types((await office.get('/notifications')).body)).toContain('place.move_request');
      const inbox = await office.get('/inbox');
      expect(inbox.body.items.filter((i: { type: string; entityId: string }) => i.type === 'place.move_request' && i.entityId === `${id}:${clientId}`)).toHaveLength(1);
      expect(inbox.body.counts['place.move_request']).toBeGreaterThanOrEqual(1);
      expect((await office.get('/places/move-requests')).body.items.map((p: { id: string }) => p.id)).toContain(id);
    }
    // Staff without place.manage are not told.
    expect(types((await (await as(t, FS2)).get('/notifications')).body)).not.toContain('place.move_request');

    const decided = await bmb.post(`/places/${id}/move-request/decision`, { decision: 'approve' });
    expect(decided.status).toBe(200);
    expect(decided.body).toMatchObject({ location: { lat: 22.712, lng: 90.38 }, lastMoveDecision: { decision: 'approve', by: { id: bmB.id } } });
    // The decision closes the one item for everyone.
    for (const office of [bm, bmb]) expect((await office.get('/inbox')).body.items.map((i: { entityId: string }) => i.entityId)).not.toContain(`${id}:${clientId}`);

    const gone = await bmb.delete(`/places/${id}`);
    expect(gone.body.status).toBe('deleted');
    expect((await fs1.get(`/places/${id}`)).status).toBe(404);
  });
});

describe('offline direct move by the office (1.43.0, ADR-055)', () => {
  const push = async (phone: string, mutations: unknown[]) => (await as(t, phone)).post('/sync/push', { deviceId: `dev-${phone}`, mutations });
  let id = '';
  let requestClientId = '';
  const ghat = { lat: 22.72, lng: 90.39 };
  const there = { lat: 22.721, lng: 90.39 }; // ~111 m north

  it('setup: a place with an open move request from field staff', async () => {
    id = (await (await as(t, FS1)).post('/places', newPlace({ name: 'Ferry Ghat', icon: 'landmark', location: ghat }))).body.id;
    requestClientId = randomUUID();
    expect((await (await as(t, FS2)).post(`/places/${id}/move-request`, { clientId: requestClientId, location: { lat: 22.7205, lng: 90.39 } })).status).toBe(201);
  });

  it('field staff sending a location are refused per mutation; their word edits still apply', async () => {
    const r = await push(FS1, [mut('place_edit', { placeId: id, location: there }), mut('place_edit', { placeId: id, name: 'Ferry Ghat (old)' })]);
    expect(r.status).toBe(200);
    expectConforms('POST', '/sync/push', 200, r.body);
    expect(r.body.results[0]).toMatchObject({ result: 'rejected', error: { code: 'FORBIDDEN', details: { reason: 'MOVE_NEEDS_MANAGE' } } });
    expect(r.body.results[1]).toMatchObject({ result: 'applied', entityId: id });
    const p = (await (await as(t, BM)).get(`/places/${id}`)).body;
    expect(p).toMatchObject({ name: 'Ferry Ghat (old)', location: ghat, pendingMove: { requestedBy: { id: s.fs2.id } } });
    // A staff member's name and location together are refused as a whole: nothing half-applied.
    const both = await push(FS1, [mut('place_edit', { placeId: id, name: 'Moved', location: there })]);
    expect(both.body.results[0].result).toBe('rejected');
    expect((await (await as(t, BM)).get(`/places/${id}`)).body.name).toBe('Ferry Ghat (old)');
  });

  it('outside Bangladesh is refused (OUTSIDE_BANGLADESH); unknown fields are 400', async () => {
    const r = await push(BM, [mut('place_edit', { placeId: id, location: { lat: 40, lng: 90 } }), mut('place_edit', { placeId: id, location: there, capturedAt: 'x' })]);
    expect(r.body.results[0]).toMatchObject({ result: 'rejected', error: { code: 'BUSINESS_RULE', details: { rule: 'OUTSIDE_BANGLADESH' } } });
    expect(r.body.results[1]).toMatchObject({ result: 'rejected', error: { code: 'VALIDATION_FAILED' } });
  });

  it('the office moves a place through sync; the open request is closed as rejected; a replay changes nothing', async () => {
    const before = (await (await as(t, BM)).get(`/places/${id}`)).body.version as number;
    const m = mut('place_edit', { placeId: id, location: there });
    const r = await push(BM, [m]);
    expectConforms('POST', '/sync/push', 200, r.body);
    expect(r.body.results[0]).toMatchObject({ result: 'applied', entityId: id, version: before + 1 });
    const p = (await (await as(t, BM)).get(`/places/${id}`)).body;
    expect(p).toMatchObject({ location: there, pendingMove: null, lastMoveDecision: { decision: 'reject', reason: 'Moved by the office', by: { id: s.bm.id }, requestedBy: { id: s.fs2.id } } });
    expect(p.events.at(-1)).toMatchObject({ type: 'moved', by: { id: s.bm.id }, from: ghat, to: there });
    // The office inbox item closes and the requester is told.
    expect((await (await as(t, BM)).get('/inbox')).body.items.map((i: { entityId: string }) => i.entityId)).not.toContain(`${id}:${requestClientId}`);
    const told = (await (await as(t, FS2)).get('/notifications')).body.items.filter((n: { type: string; data?: { placeId?: string } }) => n.type === 'place.move_decided' && n.data?.placeId === id);
    expect(told).toHaveLength(1);

    // The same mutation again (lost response): replayed, no second move, no second audit line.
    const again = await push(BM, [m]);
    expect(again.body.results[0]).toMatchObject({ result: 'replayed', entityId: id, version: before + 1 });
    // The same point under a new mutationId (typed twice) is a no-op as on PATCH.
    const same = await push(BM, [mut('place_edit', { placeId: id, location: there })]);
    expect(same.body.results[0]).toMatchObject({ result: 'applied', version: before + 1 });
    const actions = (await AuditLogModel.find({ entity: 'place', entityId: id }).sort({ _id: 1 }).lean()).map((a) => a.action);
    expect(actions.filter((a) => a === 'place.moved')).toHaveLength(1);
    expect(actions.at(-1)).toBe('place.moved');

    // Every branch pulls the new point.
    const pull = await (await as(t, FSB)).get('/sync/pull?cursor=s_0');
    expect(pull.body.changes.find((x: { entity: string; id: string }) => x.entity === 'place' && x.id === id)?.data).toMatchObject({ location: there, pendingMove: null });
  });

  it('a super admin moves by placeClientId too; a deleted place is PLACE_DELETED for the office', async () => {
    const created = newPlace({ name: 'Tea Stall', icon: 'shop', location: ghat });
    const sa = await push(SA, [mut('place', created), mut('place_edit', { placeClientId: created.clientId, location: there })]);
    expect(sa.body.results.map((x: { result: string }) => x.result)).toEqual(['applied', 'applied']);
    expect((await (await as(t, SA)).get(`/places/${sa.body.results[0].entityId}`)).body.location).toEqual(there);

    expect((await (await as(t, BM)).delete(`/places/${id}`)).status).toBe(200);
    const r = await push(BM, [mut('place_edit', { placeId: id, location: ghat })]);
    expect(r.body.results[0]).toMatchObject({ result: 'rejected', error: { code: 'INVALID_STATE', details: { reason: 'PLACE_DELETED' } } });
    // Field staff no longer see it at all.
    expect((await push(FS1, [mut('place_edit', { placeId: id, location: ghat })])).body.results[0].error.code).toBe('NOT_FOUND');
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
