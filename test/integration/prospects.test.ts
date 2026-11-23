import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, client, createTestApp, login, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { setFlagSystem } from '../../src/modules/flags/index.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { getByErpId } from '../../src/modules/customers/index.js';
import { AuditLogModel } from '../../src/modules/audit/models/audit-log.model.js';
import { prospectDashboardStats } from '../../src/modules/prospects/index.js';
import type { UserView } from '../../src/modules/users/index.js';
import type { AuthUser } from '../../src/core/security/types.js';

let t: TestApp;
let s: Seeded;
const SA = '01700000001';
const BM = '01700000002';
const FS1 = '01700000003';
const FS2 = '01700000004';
const FSB = '01700000005';
const VW = '01700000006';
const cust: Record<string, string> = {};
const mut = (entity: string, payload: Record<string, unknown>) => ({ mutationId: randomUUID(), entity, op: 'create', payload });
const newProspect = (over: Record<string, unknown> = {}) => ({ clientId: randomUUID(), name: 'Karim Mia', phones: [{ number: '017-1234 5678', label: 'Own' }], address: 'Bazaar road, Barishal', note: 'Wants a fridge', location: { lat: 22.7012, lng: 90.3711, accuracyM: 12 }, ...over });
const asWeb = async (phone: string) => {
  const l = await login(t.app, phone, { client: 'web', deviceId: `web-${phone}` });
  return client(t.app, l.accessToken);
};
const ids = (body: { items: { id: string }[] }) => body.items.map((i) => i.id);

/** Ids created in the story below, by who made them. */
const p: Record<string, string> = {};

beforeAll(async () => {
  t = await createTestApp(); // 2026-11-15 10:00 Dhaka
  s = await seedBasics(t);
  await deltaSync();
  for (const e of ['100245', '100246', '100247', '200301']) cust[e] = (await getByErpId(e))!.id;
});
afterAll(async () => t.close());

describe('recording a prospect (POST /prospects)', () => {
  it('field staff record one in their home branch; numbers are normalised; a repeat clientId is a replay', async () => {
    const fs1 = await as(t, FS1);
    // A branchId from field staff is ignored: they always get their home branch.
    const body = newProspect({ branchId: s.branchB });
    const r = await fs1.post('/prospects', body);
    expect(r.status).toBe(201);
    expectConforms('POST', '/prospects', 201, r.body);
    p.fs1a = r.body.id;
    expect(r.body).toMatchObject({
      clientId: body.clientId,
      name: 'Karim Mia',
      phones: [{ number: '+8801712345678', label: 'Own' }],
      address: 'Bazaar road, Barishal',
      note: 'Wants a fridge',
      location: { lat: 22.7012, lng: 90.3711, accuracyM: 12 },
      branchId: s.branchA,
      createdBy: { id: s.fs1.id, name: 'Rakib Hasan' },
      createdAt: '2026-11-15T04:00:00.000Z',
      createdDate: '2026-11-15',
      status: 'new',
      convertedCustomerId: null,
      convertedErpCustomerId: null,
      convertedAt: null,
      convertedBy: null,
      fromProspectId: null,
      version: 1,
    });
    expect(r.body.history).toEqual([{ status: 'new', at: '2026-11-15T04:00:00.000Z', by: { id: s.fs1.id, name: 'Rakib Hasan' }, reason: null, convertedCustomerId: null, convertedErpCustomerId: null }]);
    // Staff entries from the app are not office actions: no audit line.
    expect(await AuditLogModel.countDocuments({ entity: 'prospect', entityId: p.fs1a })).toBe(0);

    const again = await fs1.post('/prospects', body);
    expect(again.status).toBe(200);
    expectConforms('POST', '/prospects', 200, again.body);
    expect(again.body.id).toBe(p.fs1a);

    const other = await (await as(t, FS2)).post('/prospects', body);
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('IDEMPOTENCY_MISMATCH');
  });

  it('401 without a token, 400 for bad input, 403 for the viewer', async () => {
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/prospects', payload: newProspect() })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/prospects' })).statusCode).toBe(401);
    const fs1 = await as(t, FS1);
    const bad = await fs1.post('/prospects', newProspect({ phones: [{ number: '01712345678' }, { number: '01212345678' }] }));
    expect(bad.status).toBe(400);
    expect(bad.body.details.fields).toEqual([{ path: 'phones.1.number', message: expect.any(String) }]);
    expect((await fs1.post('/prospects', newProspect({ name: '  ' }))).status).toBe(400);
    expect((await fs1.post('/prospects', newProspect({ name: 'x'.repeat(121) }))).status).toBe(400);
    expect((await fs1.post('/prospects', newProspect({ clientId: 'nope' }))).status).toBe(400);
    expect((await fs1.post('/prospects', newProspect({ location: { lat: 99, lng: 90 } }))).status).toBe(400);
    expect((await fs1.post('/prospects', newProspect({ phones: Array.from({ length: 6 }, () => ({ number: '01712345678' })) }))).status).toBe(400);
    expect((await fs1.post('/prospects', newProspect({ fromProspectId: 'abc' }))).status).toBe(400);
    const vw = await as(t, VW);
    const r = await vw.post('/prospects', newProspect());
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('FORBIDDEN');
  });

  it('office users may name a branch in their scope; web entries are audited without full numbers', async () => {
    const sa = await asWeb(SA);
    const r = await sa.post('/prospects', newProspect({ name: 'Patuakhali Traders', phones: [{ number: '+8801812345678' }], address: 'Launch ghat', note: undefined, location: null, branchId: s.branchB }));
    expect(r.status).toBe(201);
    expectConforms('POST', '/prospects', 201, r.body);
    p.saB = r.body.id;
    expect(r.body).toMatchObject({ branchId: s.branchB, note: null, location: null, phones: [{ number: '+8801812345678', label: null }] });
    const a = await AuditLogModel.findOne({ entity: 'prospect', entityId: p.saB, action: 'prospect.created' }).lean();
    expect(a?.branchId).toBe(s.branchB);
    expect(JSON.stringify(a?.after)).not.toContain('8801812345678');
    expect((a?.after as { phones: string[] }).phones).toEqual(['…5678']);

    const bm = await asWeb(BM);
    const out = await bm.post('/prospects', newProspect({ branchId: s.branchB }));
    expect(out.status).toBe(400);
    expect(out.body.details.fields[0].path).toBe('branchId');
    expect((await bm.post('/prospects', newProspect({ branchId: 'not-a-branch' }))).status).toBe(400);
    const own = await bm.post('/prospects', newProspect({ name: 'Manager lead', phones: [] }));
    expect(own.status).toBe(201);
    expect(own.body.branchId).toBe(s.branchA);
    p.bmA = own.body.id;
  });
});

describe('offline (sync mutation and entity `prospect`)', () => {
  it('a prospect pushed from the app is created once; the creator pulls it and gets it in the bootstrap', async () => {
    const fs2 = await as(t, FS2);
    const body = newProspect({ name: 'Sumon Electronics', phones: [{ number: '01912345678', label: 'Shop' }], address: 'College road' });
    const m = mut('prospect', body);
    const push = await fs2.post('/sync/push', { deviceId: `dev-${FS2}`, mutations: [m, mut('prospect', body)] });
    expect(push.status).toBe(200);
    expectConforms('POST', '/sync/push', 200, push.body);
    const [a, b] = push.body.results;
    expect(a).toMatchObject({ result: 'applied', status: 'new', version: 1 });
    expect(b).toMatchObject({ result: 'replayed', entityId: a.entityId });
    p.fs2a = a.entityId;
    // Same mutation again (a lost answer): replayed.
    expect((await fs2.post('/sync/push', { deviceId: `dev-${FS2}`, mutations: [m] })).body.results[0]).toMatchObject({ result: 'replayed', entityId: p.fs2a });
    // Bad payload: rejected, not applied.
    const bad = await fs2.post('/sync/push', { deviceId: `dev-${FS2}`, mutations: [mut('prospect', { clientId: randomUUID() })] });
    expect(bad.body.results[0]).toMatchObject({ result: 'rejected', error: { code: 'VALIDATION_FAILED' } });

    const pull = await fs2.get('/sync/pull?cursor=s_0');
    expect(pull.status).toBe(200);
    expectConforms('GET', '/sync/pull', 200, pull.body);
    const change = pull.body.changes.find((x: { entity: string; id: string }) => x.entity === 'prospect' && x.id === p.fs2a);
    expect(change.data).toMatchObject({ name: 'Sumon Electronics', clientId: body.clientId, branchId: s.branchA, phones: [{ number: '+8801912345678', label: 'Shop' }] });
    // Another staff member's prospects never reach this device.
    expect(pull.body.changes.some((x: { entity: string; id: string }) => x.entity === 'prospect' && x.id === p.fs1a)).toBe(false);

    const boot = await fs2.get('/sync/bootstrap');
    expect(boot.status).toBe(200);
    expectConforms('GET', '/sync/bootstrap', 200, boot.body);
    expect(boot.body.items.filter((i: { entity: string }) => i.entity === 'prospect').map((i: { data: { id: string } }) => i.data.id)).toEqual([p.fs2a]);

    // A viewer has neither prospect.create nor any way to push one.
    const vw = await as(t, VW);
    expect((await vw.post('/sync/push', { deviceId: `dev-${VW}`, mutations: [mut('prospect', newProspect())] })).body.results[0].error.code).toBe('FORBIDDEN');
  });
});

describe('reading prospects (GET /prospects, /prospects/{id})', () => {
  beforeAll(async () => {
    const fsB = await as(t, FSB);
    p.fsB = (await fsB.post('/prospects', newProspect({ name: 'Babul Store', phones: [{ number: '01612345678' }], address: 'Kuakata road', note: 'Asked about solar' }))).body.id;
    // Just after Dhaka midnight (18:00 UTC): the business date is already the 16th.
    t.clock.set('2026-11-15T18:30:00Z');
    const late = await (await as(t, FS1)).post('/prospects', newProspect({ name: 'Rahima Begum', phones: [{ number: '01556677889' }], address: 'Nathullabad', note: 'Night market tailor' }));
    expect(late.body.createdDate).toBe('2026-11-16');
    p.fs1b = late.body.id;
    t.clock.set('2026-11-16T04:00:00Z');
  });

  it('field staff (prospect.create only) see the ones they recorded', async () => {
    const fs1 = await as(t, FS1);
    const r = await fs1.get('/prospects');
    expect(r.status).toBe(200);
    expectConforms('GET', '/prospects', 200, r.body);
    expect(ids(r.body)).toEqual([p.fs1b, p.fs1a]);
    expect(r.body.total).toBe(2);
    // Asking for someone else's: empty, never theirs.
    expect((await fs1.get(`/prospects?createdBy=${s.fs2.id}`)).body.total).toBe(0);
    expect((await fs1.get(`/prospects/${p.fs1a}`)).status).toBe(200);
    expectConforms('GET', `/prospects/${p.fs1a}`, 200, (await fs1.get(`/prospects/${p.fs1a}`)).body);
    const other = await fs1.get(`/prospects/${p.fs2a}`);
    expect(other.status).toBe(404);
    expectConforms('GET', `/prospects/${p.fs2a}`, 404, other.body);
    expect((await fs1.get('/prospects/not-an-id')).status).toBe(404);
  });

  it('prospect.view sees the branch scope; the super admin sees all; out of scope is 404', async () => {
    const bm = await asWeb(BM);
    const a = await bm.get('/prospects');
    expect(ids(a.body).sort()).toEqual([p.fs1a, p.fs1b, p.fs2a, p.bmA].sort());
    expect(a.body.total).toBe(4);
    expect((await bm.get(`/prospects/${p.fsB}`)).status).toBe(404);
    expect((await bm.get(`/prospects?branchId=${s.branchB}`)).body.total).toBe(0);
    const vw = await asWeb(VW);
    expect((await vw.get('/prospects')).body.total).toBe(4);
    const sa = await asWeb(SA);
    expect((await sa.get('/prospects')).body.total).toBe(6);
    expect(ids((await sa.get(`/prospects?branchId=${s.branchB}`)).body).sort()).toEqual([p.saB, p.fsB].sort());
    const fsB = await as(t, FSB);
    expect((await fsB.get(`/prospects/${p.fs1a}`)).status).toBe(404);
  });

  it('filters: from/to (Dhaka creation date), createdBy, status, q on name, phone digits, address and note', async () => {
    const sa = await asWeb(SA);
    const total = async (qs: string) => {
      const r = await sa.get(`/prospects?${qs}`);
      expect(r.status).toBe(200);
      return r.body.total as number;
    };
    expect(await total('from=2026-11-16')).toBe(1);
    expect(await total('to=2026-11-15')).toBe(5);
    expect(await total('from=2026-11-15&to=2026-11-15')).toBe(5);
    expect(await total(`createdBy=${s.fs1.id}`)).toBe(2);
    expect(await total('status=new')).toBe(6);
    expect(await total('status=converted')).toBe(0);
    expect(await total('q=rahima')).toBe(1); // name, case-insensitive
    expect(await total('q=0155-667')).toBe(1); // phone digits
    expect(await total('q=1556677')).toBe(1);
    expect(await total('q=kuakata')).toBe(1); // address
    expect(await total('q=solar')).toBe(1); // note
    expect(await total('q=.*')).toBe(0); // regex characters are text
    const bad = await sa.get('/prospects?from=2026-11-16&to=2026-11-15');
    expect(bad.status).toBe(400);
    expectConforms('GET', '/prospects', 400, bad.body);
    expect((await sa.get('/prospects?status=maybe')).status).toBe(400);
    expect((await sa.get('/prospects?limit=101')).status).toBe(400);
  });

  it('pages newest first by cursor; total counts every page', async () => {
    const sa = await asWeb(SA);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r: { body: { items: { id: string }[]; nextCursor: string | null; total: number } } = await sa.get(`/prospects?limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(r.body.total).toBe(6);
      seen.push(...ids(r.body));
      cursor = r.body.nextCursor;
    } while (cursor);
    // Newest first: ObjectIds grow with creation, so the pages together are in descending id order without gaps.
    expect(seen).toEqual([...new Set(seen)].sort((x, y) => y.localeCompare(x)));
    expect(seen).toHaveLength(6);
    expect(seen[0]).toBe(p.fs1b);
  });
});

describe('office work: edit, convert, re-open, new from old', () => {
  it('PATCH edits details and status; every status change is in history; the creator pulls the change', async () => {
    const bm = await asWeb(BM);
    const r = await bm.patch(`/prospects/${p.fs1a}`, { status: 'contacted', reason: 'Called, will visit Friday', note: 'Wants a 2-door fridge', phones: [{ number: '01712345678', label: 'Own' }, { number: '01812345670' }] });
    expect(r.status).toBe(200);
    expectConforms('PATCH', `/prospects/${p.fs1a}`, 200, r.body);
    expect(r.body).toMatchObject({ status: 'contacted', note: 'Wants a 2-door fridge', version: 2, statusChangedAt: '2026-11-16T04:00:00.000Z', updatedAt: '2026-11-16T04:00:00.000Z' });
    expect(r.body.phones).toEqual([{ number: '+8801712345678', label: 'Own' }, { number: '+8801812345670', label: null }]);
    expect(r.body.history.map((h: { status: string }) => h.status)).toEqual(['new', 'contacted']);
    expect(r.body.history[1]).toMatchObject({ by: { id: s.bm.id, name: 'Manager A' }, reason: 'Called, will visit Friday' });
    expect(await AuditLogModel.countDocuments({ entity: 'prospect', entityId: p.fs1a, action: 'prospect.updated' })).toBe(1);

    // The same values again change nothing (no version bump, no audit line).
    const same = await bm.patch(`/prospects/${p.fs1a}`, { status: 'contacted', note: 'Wants a 2-door fridge' });
    expect(same.body.version).toBe(2);
    expect(await AuditLogModel.countDocuments({ entity: 'prospect', entityId: p.fs1a, action: 'prospect.updated' })).toBe(1);
    // Details only: no new history entry. Clearing address and location.
    const det = await bm.patch(`/prospects/${p.fs1a}`, { address: null, location: null, name: 'Karim Mia (shop)' });
    expect(det.body).toMatchObject({ address: null, location: null, name: 'Karim Mia (shop)', version: 3 });
    expect(det.body.history).toHaveLength(2);

    const pull = await (await as(t, FS1)).get('/sync/pull?cursor=s_0');
    const changes = pull.body.changes.filter((x: { entity: string; id: string }) => x.entity === 'prospect' && x.id === p.fs1a);
    expect(changes.at(-1).data).toMatchObject({ status: 'contacted', name: 'Karim Mia (shop)', version: 3 });
  });

  it('PATCH: 400 for nothing or a bad status, 403 without prospect.manage, 404 out of scope', async () => {
    const bm = await asWeb(BM);
    expect((await bm.patch(`/prospects/${p.fs1a}`, {})).status).toBe(400);
    expect((await bm.patch(`/prospects/${p.fs1a}`, { status: 'converted' })).status).toBe(400);
    expect((await bm.patch(`/prospects/${p.fs1a}`, { phones: [{ number: '123' }] })).status).toBe(400);
    const nf = await bm.patch(`/prospects/${p.fsB}`, { status: 'dropped' });
    expect(nf.status).toBe(404);
    expectConforms('PATCH', `/prospects/${p.fsB}`, 404, nf.body);
    expect((await (await as(t, FS1)).patch(`/prospects/${p.fs1a}`, { status: 'dropped' })).status).toBe(403);
    expect((await (await asWeb(VW)).post(`/prospects/${p.fs1a}/convert`, { customerId: cust['100245'] })).status).toBe(403);
    expect((await (await as(t, FS1)).post(`/prospects/${p.fs1a}/reopen`, { reason: 'came back again' })).status).toBe(403);
  });

  it('converts to a FOS customer once; re-open clears the link (kept in history); converts again', async () => {
    const bm = await asWeb(BM);
    expect((await bm.post(`/prospects/${p.fs1a}/convert`, {})).status).toBe(400);
    const out = await bm.post(`/prospects/${p.fs1a}/convert`, { customerId: cust['200301'] });
    expect(out.status).toBe(404); // another branch's customer
    expectConforms('POST', `/prospects/${p.fs1a}/convert`, 404, out.body);
    expect((await bm.post(`/prospects/${p.fs1a}/convert`, { customerId: 'nope' })).status).toBe(404);
    expect((await bm.post(`/prospects/${p.fsB}/convert`, { customerId: cust['100245'] })).status).toBe(404);

    const r = await bm.post(`/prospects/${p.fs1a}/convert`, { customerId: cust['100245'], note: 'Bought a fridge on installment' });
    expect(r.status).toBe(200);
    expectConforms('POST', `/prospects/${p.fs1a}/convert`, 200, r.body);
    expect(r.body).toMatchObject({ status: 'converted', convertedCustomerId: cust['100245'], convertedErpCustomerId: 'BRL01-100245', convertedAt: '2026-11-16T04:00:00.000Z', convertedBy: { id: s.bm.id, name: 'Manager A' } });
    expect(r.body.history.at(-1)).toMatchObject({ status: 'converted', reason: 'Bought a fridge on installment', convertedCustomerId: cust['100245'], convertedErpCustomerId: 'BRL01-100245' });
    expect(await AuditLogModel.countDocuments({ entity: 'prospect', entityId: p.fs1a, action: 'prospect.converted' })).toBe(1);

    const twice = await bm.post(`/prospects/${p.fs1a}/convert`, { customerId: cust['100246'] });
    expect(twice.status).toBe(409);
    expectConforms('POST', `/prospects/${p.fs1a}/convert`, 409, twice.body);
    expect(twice.body).toMatchObject({ code: 'INVALID_STATE', details: { reason: 'PROSPECT_CONVERTED' } });
    const patch = await bm.patch(`/prospects/${p.fs1a}`, { status: 'contacted' });
    expect(patch.status).toBe(409);
    expect(patch.body.details.reason).toBe('PROSPECT_CONVERTED');

    expect((await bm.post(`/prospects/${p.fs1a}/reopen`, { reason: 'no' })).status).toBe(400);
    const re = await bm.post(`/prospects/${p.fs1a}/reopen`, { reason: 'Wrong customer linked' });
    expect(re.status).toBe(200);
    expectConforms('POST', `/prospects/${p.fs1a}/reopen`, 200, re.body);
    expect(re.body).toMatchObject({ status: 'new', convertedCustomerId: null, convertedErpCustomerId: null, convertedAt: null, convertedBy: null });
    expect(re.body.history.map((h: { status: string }) => h.status)).toEqual(['new', 'contacted', 'converted', 'new']);
    expect(re.body.history[2].convertedCustomerId).toBe(cust['100245']);
    expect(await AuditLogModel.countDocuments({ entity: 'prospect', entityId: p.fs1a, action: 'prospect.reopened' })).toBe(1);

    const open = await bm.post(`/prospects/${p.fs1a}/reopen`, { reason: 'once more please' });
    expect(open.status).toBe(409);
    expectConforms('POST', `/prospects/${p.fs1a}/reopen`, 409, open.body);
    expect(open.body.details.reason).toBe('PROSPECT_OPEN');

    // By ERP customer code: the FOS customer is found by its code…
    const byCode = await bm.post(`/prospects/${p.fs1a}/convert`, { erpCustomerCode: 'BRL01-100246' });
    expect(byCode.body).toMatchObject({ status: 'converted', convertedCustomerId: cust['100246'], convertedErpCustomerId: 'BRL01-100246' });
  });

  it('an ERP id resolves too; an unknown code is kept as given; dropped prospects re-open', async () => {
    const bm = await asWeb(BM);
    const byErpId = await bm.post(`/prospects/${p.fs2a}/convert`, { erpCustomerCode: '100247' });
    expect(byErpId.body).toMatchObject({ convertedCustomerId: cust['100247'], convertedErpCustomerId: 'BRL01-100247' });
    const unknown = await bm.post(`/prospects/${p.bmA}/convert`, { erpCustomerCode: 'BRL01-999999' });
    expect(unknown.status).toBe(200);
    expect(unknown.body).toMatchObject({ convertedCustomerId: null, convertedErpCustomerId: 'BRL01-999999' });
    // Another branch's customer is not linked through its code either.
    const sa = await asWeb(SA);
    const other = await bm.post(`/prospects/${p.fs1b}/convert`, { erpCustomerCode: 'PTK01-200301' });
    expect(other.body).toMatchObject({ convertedCustomerId: null, convertedErpCustomerId: 'PTK01-200301' });
    expect((await sa.post(`/prospects/${p.fs1b}/reopen`, { reason: 'Linked by mistake' })).status).toBe(200);

    const drop = await bm.patch(`/prospects/${p.fs1b}`, { status: 'dropped', reason: 'Moved away' });
    expect(drop.body.status).toBe('dropped');
    const back = await bm.post(`/prospects/${p.fs1b}/reopen`, { reason: 'Moved back to town' });
    expect(back.body.status).toBe('new');
  });

  it('the office creates a new prospect from an old one (fromProspectId)', async () => {
    const bm = await asWeb(BM);
    const r = await bm.post('/prospects', newProspect({ name: 'Sumon Electronics', fromProspectId: p.fs2a }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ fromProspectId: p.fs2a, status: 'new', createdBy: { id: s.bm.id } });
    expect(r.body.history[0].reason).toContain(p.fs2a);
    // An old prospect the caller cannot see is refused.
    expect((await bm.post('/prospects', newProspect({ fromProspectId: p.fsB }))).status).toBe(400);
  });
});

describe('dashboard counters (prospectDashboardStats)', () => {
  it('created and converted in range by Dhaka date, open now; scoped like GET /prospects', async () => {
    const userOf = (u: UserView): AuthUser => ({ id: u.id, role: u.role, branchIds: u.branchIds, name: u.name, employeeCode: u.employeeCode, sessionId: 'x', deviceId: null, client: 'web', mustChangePassword: false, locale: 'en' });
    const sa = userOf(s.sa);
    expect(await prospectDashboardStats(sa, undefined, '2026-11-15', '2026-11-15')).toEqual({ created: 5, converted: 0, openNow: 4 });
    expect(await prospectDashboardStats(sa, undefined, '2026-11-16', '2026-11-16')).toEqual({ created: 2, converted: 3, openNow: 4 });
    expect(await prospectDashboardStats(sa, s.branchB, '2026-11-01', '2026-11-30')).toEqual({ created: 2, converted: 0, openNow: 2 });
    const fs1 = userOf(s.fs1);
    expect(await prospectDashboardStats(fs1, undefined, '2026-11-01', '2026-11-30')).toEqual({ created: 2, converted: 1, openNow: 1 });
  });
});

describe('module flag', () => {
  it('off: the routes and the sync mutation answer FEATURE_DISABLED', async () => {
    await setFlagSystem('module.prospects', false);
    const fs1 = await as(t, FS1);
    const r = await fs1.get('/prospects');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('FEATURE_DISABLED');
    expect((await fs1.post('/prospects', newProspect())).body.code).toBe('FEATURE_DISABLED');
    const push = await fs1.post('/sync/push', { deviceId: `dev-${FS1}`, mutations: [mut('prospect', newProspect())] });
    expect(push.body.results[0].error.code).toBe('FEATURE_DISABLED');
    await setFlagSystem('module.prospects', true);
    expect((await fs1.get('/prospects')).status).toBe(200);
  });
});
