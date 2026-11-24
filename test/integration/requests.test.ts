import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { as, client, createTestApp, login, PASSWORD, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { setFlagSystem } from '../../src/modules/flags/index.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { getByErpId } from '../../src/modules/customers/index.js';
import { createSystemUser } from '../../src/modules/users/index.js';
import { AuditLogModel } from '../../src/modules/audit/models/audit-log.model.js';

/** Requests / tickets (1.48.0, FR-REQ-001..006, ADR-066). One story, in order: each block builds on the previous. */
let t: TestApp;
let s: Seeded;
let amId: string;
const SA = '01700000001';
const BM = '01700000002';
const FS1 = '01700000003';
const FS2 = '01700000004';
const FSB = '01700000005';
const VW = '01700000006';
const AM = '01700000027';
const cust: Record<string, string> = {};
const r: Record<string, string> = {};

const web = async (phone: string) => client(t.app, (await login(t.app, phone, { client: 'web', deviceId: `web-${phone}` })).accessToken);
const newRequest = (over: Record<string, unknown> = {}) => ({ clientId: randomUUID(), type: 'request', priority: 'normal', title: 'Need receipt book', body: 'My receipt book has 3 pages left.', ...over });
const mut = (entity: string, payload: Record<string, unknown>) => ({ mutationId: randomUUID(), entity, op: 'create', payload });
const ids = (body: { items: { id: string }[] }) => body.items.map((i) => i.id);
/** Notifications of a type (optionally about one request) in the user's center. */
const notes = async (phone: string, type: string, requestId?: string) =>
  ((await (await web(phone)).get('/notifications?limit=100')).body.items as { type: string; data?: Record<string, string> }[]).filter((n) => n.type === type && (!requestId || n.data?.requestId === requestId)).length;

beforeAll(async () => {
  t = await createTestApp(); // 2026-11-15 10:00 Dhaka
  s = await seedBasics(t);
  await deltaSync();
  for (const e of ['100245', '200301']) cust[e] = (await getByErpId(e))!.id; // branch A, branch B
});
afterAll(async () => t.close());

describe('before any area manager exists', () => {
  it('a normal request goes to the super admins (fallback)', async () => {
    const res = await (await as(t, FS1)).post('/requests', newRequest({ title: 'Fallback' }));
    expect(res.status).toBe(201);
    r.fallback = res.body.id;
    expect(res.body).toMatchObject({ level: 'area_manager', currentQueue: 'area_manager' });
    expect(await notes(SA, 'request.created', r.fallback)).toBe(1);
  });
  it('then an area manager is made', async () => {
    amId = (await createSystemUser({ name: { en: 'Area Manager', bn: 'Area Manager' }, phone: AM, role: 'area_manager', branchIds: [s.branchA], employeeCode: 'AM002', password: PASSWORD })).id;
  });
});

describe('creating (POST /requests, FR-REQ-001/002)', () => {
  it('field staff send a normal request: area manager queue, home branch, timeline, audit, the area manager is told', async () => {
    const fs1 = await as(t, FS1);
    const body = newRequest({ branchId: s.branchB, customerId: cust['100245'], dueAt: '2026-11-17T12:00:00+06:00' });
    const res = await fs1.post('/requests', body);
    expect(res.status).toBe(201);
    expectConforms('POST', '/requests', 201, res.body);
    r.normal = res.body.id;
    expect(res.body).toMatchObject({
      clientId: body.clientId,
      type: 'request',
      priority: 'normal',
      title: 'Need receipt book',
      customerId: cust['100245'],
      photoMediaIds: [],
      branchId: s.branchA, // a branchId from field staff is ignored
      createdBy: { id: s.fs1.id, name: 'Rakib Hasan' },
      createdAt: '2026-11-15T04:00:00.000Z',
      createdDate: '2026-11-15',
      status: 'open',
      level: 'area_manager',
      currentQueue: 'area_manager',
      assignee: null,
      dueAt: '2026-11-17T06:00:00.000Z',
      resolvedAt: null,
      closedAt: null,
      version: 1,
    });
    expect(res.body.timeline).toEqual([
      { id: expect.any(String), kind: 'created', at: '2026-11-15T04:00:00.000Z', actor: { id: s.fs1.id, name: 'Rakib Hasan' }, note: null, from: null, to: { queue: 'area_manager', user: null }, status: { from: null, to: 'open' } },
    ]);
    expect(await AuditLogModel.countDocuments({ entity: 'request', entityId: r.normal, action: 'request.created' })).toBe(1);
    expect(await notes(AM, 'request.created', r.normal)).toBe(1);
    expect(await notes(SA, 'request.created', r.normal)).toBe(0); // there is an area manager now

    const again = await fs1.post('/requests', body);
    expect(again.status).toBe(200);
    expectConforms('POST', '/requests', 200, again.body);
    expect(again.body.id).toBe(r.normal);
    const other = await (await as(t, FS2)).post('/requests', body);
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('IDEMPOTENCY_MISMATCH');
  });

  it('an important one goes to the super admin queue: super admins are told and get an inbox item, area managers are not', async () => {
    const res = await (await as(t, FS1)).post('/requests', newRequest({ priority: 'important', type: 'complaint', title: 'Customer threatened me' }));
    expect(res.status).toBe(201);
    r.important = res.body.id;
    expect(res.body).toMatchObject({ level: 'super_admin', currentQueue: 'super_admin', status: 'open' });
    expect(await notes(SA, 'request.important', r.important)).toBe(1);
    expect(await notes(AM, 'request.important', r.important)).toBe(0);
    const inbox = await (await web(SA)).get('/inbox?type=request.important');
    expect(inbox.status).toBe(200);
    expect(inbox.body.items.map((i: { entityId: string }) => i.entityId)).toContain(r.important);
    // The branch manager of the creator's branch does not get the super admin's item.
    expect((await (await web(BM)).get('/inbox?type=request.important')).body.items).toEqual([]);
  });

  it('photos must be the sender\'s uploads; customers must be in scope', async () => {
    const fs1 = await as(t, FS1);
    const up = await fs1.post('/media/upload-url', { kind: 'visit_photo', contentType: 'image/jpeg', sizeBytes: 50_000, sha256: createHash('sha256').update('req-photo').digest('hex') });
    expect(up.status).toBe(201);
    const ok = await fs1.post('/requests', newRequest({ type: 'report', title: 'Broken bridge', photoMediaIds: [up.body.mediaId] }));
    expect(ok.status).toBe(201);
    expect(ok.body.photoMediaIds).toEqual([up.body.mediaId]);
    r.photo = ok.body.id;
    const notMine = await (await as(t, FS2)).post('/requests', newRequest({ photoMediaIds: [up.body.mediaId] }));
    expect(notMine.status).toBe(400);
    expect(notMine.body.details.fields[0].path).toBe('photoMediaIds.0');
    const otherBranch = await fs1.post('/requests', newRequest({ customerId: cust['200301'] }));
    expect(otherBranch.status).toBe(400);
    expect(otherBranch.body.details.fields[0].path).toBe('customerId');
  });

  it('400 on a bad body, 401 without a token, 403 without request.create, office users may pick a branch', async () => {
    const fs1 = await as(t, FS1);
    for (const bad of [{ ...newRequest(), title: '' }, { ...newRequest(), priority: 'urgent' }, { ...newRequest(), type: 'gossip' }, { ...newRequest(), clientId: 'x' }, { title: 'only' }]) {
      const res = await fs1.post('/requests', bad);
      expect(res.status).toBe(400);
      expectConforms('POST', '/requests', 400, res.body);
    }
    expect((await client(t.app).post('/requests', newRequest())).status).toBe(401);
    const vw = await (await web(VW)).post('/requests', newRequest());
    expect(vw.status).toBe(403);
    expectConforms('POST', '/requests', 403, vw.body);
    // The area manager (home branch A) files one for branch B; the branch manager cannot name branch B.
    const am = await (await web(AM)).post('/requests', newRequest({ branchId: s.branchB, title: 'Branch B shutters' }));
    expect(am.status).toBe(201);
    expect(am.body.branchId).toBe(s.branchB);
    r.amB = am.body.id;
    expect((await (await web(BM)).post('/requests', newRequest({ branchId: s.branchB }))).status).toBe(400);
    const fsB = await (await as(t, FSB)).post('/requests', newRequest({ title: 'From branch B' }));
    r.fsB = fsB.body.id;
    expect(fsB.body.branchId).toBe(s.branchB);
  });
});

describe('reading (GET /requests, /requests/{id}) and scope', () => {
  it('field staff see their own; others\' requests are 404', async () => {
    const fs1 = await as(t, FS1);
    const mine = await fs1.get('/requests');
    expect(mine.status).toBe(200);
    expectConforms('GET', '/requests', 200, mine.body);
    expect(ids(mine.body).sort()).toEqual([r.fallback, r.normal, r.important, r.photo].sort());
    expect(mine.body.total).toBe(4);
    expect(mine.body.counts).toEqual({ open: 4, in_progress: 0, forwarded: 0, resolved: 0, closed: 0, reopened: 0 });
    expect((await (await as(t, FS2)).get('/requests')).body.items).toEqual([]);
    const other = await (await as(t, FS2)).get(`/requests/${r.normal}`);
    expect(other.status).toBe(404);
    expectConforms('GET', `/requests/${r.normal}`, 404, other.body);
    expect((await fs1.get(`/requests/${r.fsB}`)).status).toBe(404);
    expect((await fs1.get('/requests/not-an-id')).status).toBe(404);
  });

  it('the branch manager sees branch A only; the area manager and the super admin see every branch', async () => {
    const bm = await web(BM);
    const bmIds = ids((await bm.get('/requests?limit=100')).body);
    expect(bmIds).toEqual(expect.arrayContaining([r.normal, r.important]));
    expect(bmIds).not.toContain(r.fsB);
    expect((await bm.get(`/requests/${r.fsB}`)).status).toBe(404);
    for (const phone of [AM, SA]) {
      const all = ids((await (await web(phone)).get('/requests?limit=100')).body);
      expect(all).toEqual(expect.arrayContaining([r.normal, r.important, r.fsB, r.amB]));
      const one = await (await web(phone)).get(`/requests/${r.fsB}`);
      expect(one.status).toBe(200);
      expectConforms('GET', `/requests/${r.fsB}`, 200, one.body);
    }
    expect((await (await web(BM)).get(`/requests?branchId=${s.branchB}`)).body.items).toEqual([]);
  });

  it('filters: priority, type, queue, status list, q, dates, createdBy, customer, branch; 400 and 401', async () => {
    const am = await web(AM);
    const q = async (query: string) => ids((await am.get(`/requests?limit=100&${query}`)).body);
    expect(await q('priority=important')).toEqual([r.important]);
    expect(await q('type=complaint')).toEqual([r.important]);
    expect(await q('queue=super_admin')).toEqual([r.important]);
    expect((await q('status=open,resolved')).length).toBe(6); // fallback, normal, important, photo, amB, fsB
    expect(await q('q=bridge')).toEqual([r.photo]);
    expect(await q(`createdBy=${s.fsB.id}`)).toEqual([r.fsB]);
    expect(await q(`customerId=${cust['100245']}`)).toEqual([r.normal]);
    expect((await q(`branchId=${s.branchB}`)).sort()).toEqual([r.amB, r.fsB].sort());
    expect((await q('from=2026-11-15&to=2026-11-15')).length).toBe(6);
    expect(await q('from=2026-11-16')).toEqual([]);
    const page = await am.get('/requests?limit=2');
    expect(page.body.items).toHaveLength(2);
    expect(page.body.total).toBe(6);
    const next = await am.get(`/requests?limit=100&cursor=${page.body.nextCursor}`);
    expect(next.body.items).toHaveLength(4);
    for (const bad of ['status=done', 'from=2026-11-16&to=2026-11-15', 'priority=high', 'limit=0', 'queue=me']) {
      const res = await am.get(`/requests?${bad}`);
      expect(res.status, bad).toBe(400);
      expectConforms('GET', '/requests', 400, res.body);
    }
    expect((await client(t.app).get('/requests')).status).toBe(401);
  });
});

describe('working a request (forward, assign, comment, resolve, reopen, close; FR-REQ-003/004/005)', () => {
  it('the branch manager may not move requests (403); 401 without a token', async () => {
    const bm = await web(BM);
    const res = await bm.post(`/requests/${r.normal}/forward`, { queue: 'super_admin', note: 'up' });
    expect(res.status).toBe(403);
    expectConforms('POST', `/requests/${r.normal}/forward`, 403, res.body);
    expect((await bm.post(`/requests/${r.normal}/assign`, { userId: s.fs2.id })).status).toBe(403);
    expect((await bm.post(`/requests/${r.normal}/resolve`, { note: 'done' })).status).toBe(403);
    expect((await client(t.app).post(`/requests/${r.normal}/resolve`, { note: 'x' })).status).toBe(401);
  });

  it('the area manager forwards a normal request to the super admin; then only the super admin queue acts on it', async () => {
    const am = await web(AM);
    const bad = await am.post(`/requests/${r.normal}/forward`, { queue: 'super_admin', userId: s.fs2.id, note: 'both' });
    expect(bad.status).toBe(400);
    expect((await am.post(`/requests/${r.normal}/forward`, { queue: 'super_admin' })).status).toBe(400); // note required
    const res = await am.post(`/requests/${r.normal}/forward`, { queue: 'super_admin', note: 'Needs budget approval' });
    expect(res.status).toBe(200);
    expectConforms('POST', `/requests/${r.normal}/forward`, 200, res.body);
    expect(res.body).toMatchObject({ status: 'forwarded', level: 'super_admin', currentQueue: 'super_admin', assignee: null, version: 2 });
    expect(res.body.timeline[1]).toMatchObject({
      kind: 'forwarded',
      actor: { id: amId, name: 'Area Manager' },
      note: 'Needs budget approval',
      from: { queue: 'area_manager', user: null },
      to: { queue: 'super_admin', user: null },
      status: { from: 'open', to: 'forwarded' },
    });
    expect(await notes(SA, 'request.forwarded', r.normal)).toBe(1);
    expect(await AuditLogModel.countDocuments({ entity: 'request', entityId: r.normal, action: 'request.forwarded', actorId: amId })).toBe(1);
    expect((await (await web(SA)).get('/inbox?type=request.important')).body.items.map((i: { entityId: string }) => i.entityId)).toContain(r.normal);
    // At super admin level the area manager can still see and comment, not move, resolve or close.
    const denied = await am.post(`/requests/${r.normal}/resolve`, { note: 'I did it' });
    expect(denied.status).toBe(403);
    expect(denied.body.details.permission).toBe('request.important.manage');
    expect((await am.post(`/requests/${r.normal}/assign`, { userId: s.fs2.id })).status).toBe(403);
    expect((await am.post(`/requests/${r.normal}/close`, {})).status).toBe(403);
    expect((await am.get(`/requests/${r.normal}`)).status).toBe(200);
  });

  it('the super admin assigns it to a field staff member; 422 for a target that cannot work requests', async () => {
    const sa = await web(SA);
    const viewer = await sa.post(`/requests/${r.normal}/assign`, { userId: s.vw.id });
    expect(viewer.status).toBe(422);
    expect(viewer.body.details.rule).toBe('REQUEST_INVALID_TARGET');
    expectConforms('POST', `/requests/${r.normal}/assign`, 422, viewer.body);
    expect((await sa.post(`/requests/${r.normal}/assign`, { userId: '000000000000000000000000' })).status).toBe(422);
    const res = await sa.post(`/requests/${r.normal}/assign`, { userId: s.fs2.id, note: 'Bring him a new book' });
    expect(res.status).toBe(200);
    expectConforms('POST', `/requests/${r.normal}/assign`, 200, res.body);
    expect(res.body).toMatchObject({ status: 'in_progress', level: 'super_admin', currentQueue: 'assignee', assignee: { id: s.fs2.id, name: 'Sumon Mia' } });
    expect(await notes(FS2, 'request.assigned', r.normal)).toBe(1);
    // No longer waiting for the super admin: the inbox item closes itself.
    expect((await sa.get('/inbox?type=request.important')).body.items.map((i: { entityId: string }) => i.entityId)).not.toContain(r.normal);
    // FS2 now sees it (assigned to them), and pulls it.
    const fs2 = await as(t, FS2);
    expect(ids((await fs2.get('/requests?assigneeId=me')).body)).toEqual([r.normal]);
    const pull = await fs2.get('/sync/pull?cursor=s_0');
    expectConforms('GET', '/sync/pull', 200, pull.body);
    expect(pull.body.changes.find((c: { entity: string; id: string }) => c.entity === 'request' && c.id === r.normal).data).toMatchObject({ assignee: { id: s.fs2.id } });
  });

  it('comments: anyone who sees it; idempotent by clientId; the creator and the assignee are told', async () => {
    const fs2 = await as(t, FS2);
    const c = { clientId: randomUUID(), text: 'I will bring it tomorrow' };
    const res = await fs2.post(`/requests/${r.normal}/comment`, c);
    expect(res.status).toBe(200);
    expectConforms('POST', `/requests/${r.normal}/comment`, 200, res.body);
    const comments = res.body.timeline.filter((e: { kind: string }) => e.kind === 'comment');
    expect(comments).toEqual([expect.objectContaining({ kind: 'comment', note: 'I will bring it tomorrow', actor: { id: s.fs2.id, name: 'Sumon Mia' }, status: null })]);
    expect((await fs2.post(`/requests/${r.normal}/comment`, c)).body.timeline.length).toBe(res.body.timeline.length);
    expect(await notes(FS1, 'request.commented', r.normal)).toBe(1);
    // The branch manager (request.view in branch A) may comment too; another field staff member may not see it.
    expect((await (await web(BM)).post(`/requests/${r.normal}/comment`, { clientId: randomUUID(), text: 'Noted' })).status).toBe(200);
    expect((await (await as(t, FSB)).post(`/requests/${r.normal}/comment`, { clientId: randomUUID(), text: 'x' })).status).toBe(404);
    expect((await fs2.post(`/requests/${r.normal}/comment`, { clientId: randomUUID(), text: '' })).status).toBe(400);
    expect((await (await web(VW)).post(`/requests/${r.normal}/comment`, { clientId: randomUUID(), text: 'viewer' })).status).toBe(200);
  });

  it('the assignee resolves with a note; the creator is told; a second resolve is 409', async () => {
    const fs2 = await as(t, FS2);
    expect((await fs2.post(`/requests/${r.normal}/resolve`, {})).status).toBe(400);
    // The assignee cannot pass it on.
    expect((await fs2.post(`/requests/${r.normal}/forward`, { queue: 'area_manager', note: 'not mine' })).status).toBe(403);
    const res = await fs2.post(`/requests/${r.normal}/resolve`, { note: 'Gave him a new receipt book' });
    expect(res.status).toBe(200);
    expectConforms('POST', `/requests/${r.normal}/resolve`, 200, res.body);
    expect(res.body).toMatchObject({ status: 'resolved', resolvedBy: { id: s.fs2.id }, resolutionNote: 'Gave him a new receipt book', resolvedAt: '2026-11-15T04:00:00.000Z' });
    expect(await notes(FS1, 'request.resolved', r.normal)).toBe(1);
    const again = await fs2.post(`/requests/${r.normal}/resolve`, { note: 'again' });
    expect(again.status).toBe(409);
    expect(again.body.details.reason).toBe('REQUEST_RESOLVED');
    expectConforms('POST', `/requests/${r.normal}/resolve`, 409, again.body);
  });

  it('the creator reopens it (back to the assignee); the super admin closes it; a closed request takes no comments', async () => {
    const fs1 = await as(t, FS1);
    const open = await fs1.post(`/requests/${r.fallback}/reopen`, { note: 'still open' });
    expect(open.status).toBe(409);
    expect(open.body.details.reason).toBe('REQUEST_OPEN');
    const res = await fs1.post(`/requests/${r.normal}/reopen`, { note: 'The book has the wrong numbers' });
    expect(res.status).toBe(200);
    expectConforms('POST', `/requests/${r.normal}/reopen`, 200, res.body);
    expect(res.body).toMatchObject({ status: 'reopened', currentQueue: 'assignee', assignee: { id: s.fs2.id }, resolvedAt: null, resolutionNote: null });
    expect(await notes(FS2, 'request.reopened', r.normal)).toBe(1);
    const sa = await web(SA);
    const closed = await sa.post(`/requests/${r.normal}/close`, { note: 'Handled by phone' });
    expect(closed.status).toBe(200);
    expectConforms('POST', `/requests/${r.normal}/close`, 200, closed.body);
    expect(closed.body).toMatchObject({ status: 'closed', closedAt: '2026-11-15T04:00:00.000Z' });
    expect(await notes(FS1, 'request.closed', r.normal)).toBe(1);
    const late = await fs1.post(`/requests/${r.normal}/comment`, { clientId: randomUUID(), text: 'hello?' });
    expect(late.status).toBe(409);
    expect(late.body.details.reason).toBe('REQUEST_CLOSED');
    expect((await sa.post(`/requests/${r.normal}/close`, {})).status).toBe(409);
  });

  it('the timeline is append-only: every earlier entry is unchanged, one entry per action, each audited', async () => {
    const full = (await (await web(SA)).get(`/requests/${r.normal}`)).body;
    expect(full.timeline.map((e: { kind: string }) => e.kind)).toEqual(['created', 'forwarded', 'assigned', 'comment', 'comment', 'comment', 'resolved', 'reopened', 'closed']);
    const created = (await (await as(t, FS1)).post('/requests', { ...newRequest(), clientId: full.clientId })).body; // replay returns the stored row
    expect(created.timeline).toEqual(full.timeline);
    expect(new Set(full.timeline.map((e: { id: string }) => e.id)).size).toBe(full.timeline.length);
    const actions = (await AuditLogModel.find({ entity: 'request', entityId: r.normal }).sort({ seq: 1 }).lean()).map((a) => a.action);
    expect(actions).toEqual(['request.created', 'request.forwarded', 'request.assigned', 'request.commented', 'request.commented', 'request.commented', 'request.resolved', 'request.reopened', 'request.closed']);
  });

  it('the area manager resolves a normal request directly; the creator withdraws one of theirs; others cannot', async () => {
    const am = await web(AM);
    const res = await am.post(`/requests/${r.fsB}/resolve`, { note: 'Shutter fixed' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('resolved');
    expect(await notes(FSB, 'request.resolved', r.fsB)).toBe(1);
    const fs1 = await as(t, FS1);
    const w = await fs1.post(`/requests/${r.photo}/close`, { note: 'Bridge already repaired' });
    expect(w.status).toBe(200);
    expect(w.body.status).toBe('closed');
    expect((await (await as(t, FS2)).post(`/requests/${r.fallback}/close`, {})).status).toBe(404);
    // A creator cannot resolve their own request.
    const own = await fs1.post(`/requests/${r.fallback}/resolve`, { note: 'self' });
    expect(own.status).toBe(403);
    // Forward to a person: an area manager may hand a request to another area manager or staff member.
    const fw = await am.post(`/requests/${r.fallback}/forward`, { userId: s.fs2.id, note: 'Please check' });
    expect(fw.status).toBe(200);
    expect(fw.body).toMatchObject({ status: 'forwarded', currentQueue: 'assignee', assignee: { id: s.fs2.id }, level: 'area_manager' });
    expect(await notes(FS2, 'request.forwarded', r.fallback)).toBe(1);
  });
});

describe('offline (sync mutations `request`, `request_comment`; entity `request`)', () => {
  it('a request and a comment on it pushed together are applied once, even when sent twice', async () => {
    const fs2 = await as(t, FS2);
    const body = newRequest({ title: 'Bike tyre burst', type: 'inform' });
    const m = mut('request', body);
    const c = mut('request_comment', { requestClientId: body.clientId, clientId: randomUUID(), text: 'Photo later' });
    const push = await fs2.post('/sync/push', { deviceId: `dev-${FS2}`, mutations: [m, c, mut('request', body), { ...c, mutationId: randomUUID() }] });
    expect(push.status).toBe(200);
    expectConforms('POST', '/sync/push', 200, push.body);
    const [a, b, a2, b2] = push.body.results;
    expect(a).toMatchObject({ result: 'applied', status: 'open', version: 1 });
    expect(b).toMatchObject({ result: 'applied', entityId: a.entityId, version: 2 });
    expect(a2).toMatchObject({ result: 'replayed', entityId: a.entityId });
    expect(b2).toMatchObject({ result: 'replayed', entityId: a.entityId });
    r.offline = a.entityId;
    // The same mutation again (a lost answer): replayed.
    expect((await fs2.post('/sync/push', { deviceId: `dev-${FS2}`, mutations: [m, c] })).body.results.map((x: { result: string }) => x.result)).toEqual(['replayed', 'replayed']);
    const got = (await fs2.get(`/requests/${r.offline}`)).body;
    expect(got.timeline.filter((e: { kind: string }) => e.kind === 'comment')).toHaveLength(1);
    expect(await notes(AM, 'request.created', r.offline)).toBe(1);
    // By server id works too; a bad payload is rejected; a viewer cannot push.
    expect((await fs2.post('/sync/push', { deviceId: `dev-${FS2}`, mutations: [mut('request_comment', { requestId: r.offline, clientId: randomUUID(), text: 'Fixed' })] })).body.results[0].result).toBe('applied');
    expect((await fs2.post('/sync/push', { deviceId: `dev-${FS2}`, mutations: [mut('request', { clientId: randomUUID() })] })).body.results[0]).toMatchObject({ result: 'rejected', error: { code: 'VALIDATION_FAILED' } });
    expect((await fs2.post('/sync/push', { deviceId: `dev-${FS2}`, mutations: [mut('request_comment', { clientId: randomUUID(), text: 'x' })] })).body.results[0]).toMatchObject({ result: 'rejected', error: { code: 'VALIDATION_FAILED' } });
    const vw = await as(t, VW);
    expect((await vw.post('/sync/push', { deviceId: `dev-${VW}`, mutations: [mut('request', newRequest())] })).body.results[0].error.code).toBe('FORBIDDEN');
  });

  it('pull and bootstrap carry the user\'s own and assigned requests with the timeline; a request taken away is deleted', async () => {
    const fs2 = await as(t, FS2);
    const boot = await fs2.get('/sync/bootstrap');
    expect(boot.status).toBe(200);
    expectConforms('GET', '/sync/bootstrap', 200, boot.body);
    const booted = boot.body.items.filter((i: { entity: string }) => i.entity === 'request').map((i: { data: { id: string } }) => i.data.id);
    expect(booted.sort()).toEqual([r.normal, r.fallback, r.offline].sort()); // own + assigned (closed today included)
    expect(booted).not.toContain(r.important);

    const before = (await fs2.get('/sync/pull?cursor=s_0')).body;
    const cursor = before.nextCursor ?? before.cursor;
    // The area manager gives FS2's assigned request to the area manager: it leaves FS2's device.
    expect((await (await web(AM)).post(`/requests/${r.fallback}/assign`, { userId: amId, note: 'I take it' })).status).toBe(200);
    const pull = await fs2.get(`/sync/pull?cursor=${cursor}`);
    expectConforms('GET', '/sync/pull', 200, pull.body);
    const change = pull.body.changes.find((x: { entity: string; id: string }) => x.entity === 'request' && x.id === r.fallback);
    expect(change.op).toBe('delete');
    // The creator still has it, with the new assignee.
    const fs1pull = await (await as(t, FS1)).get('/sync/pull?cursor=s_0');
    const mine = fs1pull.body.changes.filter((x: { entity: string; id: string }) => x.entity === 'request' && x.id === r.fallback);
    expect(mine.at(-1).data).toMatchObject({ assignee: { id: amId }, status: 'in_progress' });
    expect(mine.at(-1).data.timeline.length).toBeGreaterThan(2);
  });
});

describe('dashboard (`requestStats`) and the feature flag', () => {
  it('counts open requests by queue and the important ones, with links that list exactly them', async () => {
    const sa = await web(SA);
    const d = await sa.get('/dashboard/overview');
    expect(d.status).toBe(200);
    expectConforms('GET', '/dashboard/overview', 200, d.body);
    const rs = d.body.requestStats;
    expect(rs.superAdminQueue.count).toBe(1); // r.important
    expect(rs.importantOpen.count).toBe(1);
    expect(rs.assigned.count).toBe(1); // r.fallback with the area manager
    expect(rs.areaManagerQueue.count).toBe(2); // r.amB, r.offline
    for (const k of ['areaManagerQueue', 'superAdminQueue', 'assigned', 'importantOpen']) {
      const link = rs[k].link;
      expect(link.path).toBe('/requests');
      const list = await sa.get(`/requests?limit=100&${new URLSearchParams(link.query).toString()}`);
      expect(list.status).toBe(200);
      expect(list.body.total, k).toBe(rs[k].count);
    }
    // The branch manager's figures stay in branch A (no branch B request, not the AM's branch B one).
    const bm = (await (await web(BM)).get('/dashboard/overview')).body.requestStats;
    expect(bm.areaManagerQueue.count).toBe(1); // r.offline (FS2, branch A)
    expect((await (await web(BM)).get(`/dashboard/overview?branchId=${s.branchB}`)).status).toBe(404);
    // Field staff lack report.view: the dashboard is 403 for them.
    expect((await (await as(t, FS1)).get('/dashboard/overview')).status).toBe(403);
  });

  it('module.requests off: the routes are 403 FEATURE_DISABLED and the dashboard shows zeros', async () => {
    await setFlagSystem('module.requests', false);
    const fs1 = await as(t, FS1);
    const res = await fs1.get('/requests');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
    expect((await fs1.post('/sync/push', { deviceId: `dev-${FS1}`, mutations: [mut('request', newRequest())] })).body.results[0].error.code).toBe('FEATURE_DISABLED');
    expect((await (await web(SA)).get('/dashboard/overview')).body.requestStats.superAdminQueue.count).toBe(0);
    await setFlagSystem('module.requests', true);
  });
});
