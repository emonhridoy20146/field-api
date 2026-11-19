import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { setSystem } from '../../src/modules/settings/index.js';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { applyAssignments, getByErpId } from '../../src/modules/customers/index.js';
import { storage, type MemoryStorage } from '../../src/core/storage/index.js';
import { evaluateDue, remindToday } from '../../src/modules/promises/service.js';
import { setFlagSystem } from '../../src/modules/flags/index.js';

let t: TestApp;
let s: Seeded;
const ids: Record<string, string> = {};

beforeAll(async () => {
  t = await createTestApp();
  s = await seedBasics(t);
  // These cases cover the assigned-only rule (customers.staffVisibility = assigned); branch-wide scope: staff-visibility.test.ts.
  await setSystem('customers.staffVisibility', 'assigned');
  await deltaSync();
  for (const e of ['100245', '100246', '100248', '200301']) ids[e] = (await getByErpId(e))!.id;
  await applyAssignments([
    { customerId: ids['100245']!, assigneeId: s.fs1.id },
    { customerId: ids['100246']!, assigneeId: s.fs1.id },
    { customerId: ids['100248']!, assigneeId: s.fs2.id },
  ]);
});
afterAll(async () => t.close());

describe('media (FR-MED-001)', () => {
  it('presigns, confirms after upload, dedupes by sha256, scopes reads', async () => {
    const fs = await as(t, '01700000003');
    const sha = createHash('sha256').update('photo-1').digest('hex');
    const req = { kind: 'visit_photo', contentType: 'image/jpeg', sizeBytes: 120_000, sha256: sha };
    const u = await fs.post('/media/upload-url', req);
    expect(u.status).toBe(201);
    expectConforms('POST', '/media/upload-url', 201, u.body);
    expect(u.body.alreadyExists).toBe(false);
    expect((await fs.post(`/media/${u.body.mediaId}/confirm`)).status).toBe(409); // not uploaded yet
    (storage() as MemoryStorage).markUploaded(`visit_photo/${s.fs1.id}/${sha}.jpg`);
    expect((await fs.post(`/media/${u.body.mediaId}/confirm`)).status).toBe(200);
    expect((await fs.post('/media/upload-url', req)).body.alreadyExists).toBe(true);
    expect((await fs.get(`/media/${u.body.mediaId}/url`)).body.url).toContain('memory://get/');
    expect((await (await as(t, '01700000004')).get(`/media/${u.body.mediaId}/url`)).status).toBe(404); // other staff
    expect((await (await as(t, '01700000002')).get(`/media/${u.body.mediaId}/url`)).status).toBe(200); // branch manager
    expect((await fs.post('/media/upload-url', { ...req, kind: 'voice_note' })).status).toBe(400);
    expect((await fs.post('/media/upload-url', { ...req, sizeBytes: 5_000_000 })).status).toBe(400);
  });
});

describe('visits (FR-VIS-001)', () => {
  it('records a visit idempotently with distance and flags; checkout; list scope', async () => {
    const fs = await as(t, '01700000003');
    const body = { clientId: randomUUID(), customerId: ids['100245'], checkInAt: '2026-11-15T03:30:00Z', outcome: 'not_home', geo: { lat: 22.7106, lng: 90.3703, accuracyM: 9 } };
    const r = await fs.post('/visits', body);
    expect(r.status).toBe(201);
    expectConforms('POST', '/visits', 201, r.body);
    expect(r.body.distanceToPinM).toBeLessThan(50);
    expect(r.body.flags).toEqual([]);
    expect((await fs.post('/visits', body)).status).toBe(200);
    const far = await fs.post('/visits', { ...body, clientId: randomUUID(), geo: null, geoUnavailableReason: 'timeout' });
    expect(far.body.flags).toEqual(['no_location']);
    const out = await fs.patch(`/visits/${r.body.id}/checkout`, { checkOutAt: '2026-11-15T03:40:00Z', outcome: 'promised' });
    expect(out.body).toMatchObject({ outcome: 'promised', checkOutAt: '2026-11-15T03:40:00.000Z' });
    expect((await fs.patch(`/visits/${r.body.id}/checkout`, { checkOutAt: '2026-11-15T03:00:00Z' })).status).toBe(400);
    expect((await (await as(t, '01700000004')).get('/visits')).body.items).toHaveLength(0);
    expect((await (await as(t, '01700000002')).get(`/visits?customerId=${ids['100245']}`)).body.items).toHaveLength(2);
    expect((await fs.post('/visits', { ...body, clientId: randomUUID(), customerId: ids['200301'] })).status).toBe(404);
    const list = await fs.get('/customers');
    expect(list.body.items.find((c: { id: string }) => c.id === ids['100245']).lastVisitAt).toBe('2026-11-15T03:30:00.000Z');
  });
});

describe('notes and contact attempts (FR-NOTE-001, FR-M-014)', () => {
  it('note is editable for 15 minutes only; visible on detail and timeline', async () => {
    const fs = await as(t, '01700000003');
    const r = await fs.post(`/customers/${ids['100245']}/notes`, { clientId: randomUUID(), text: 'Will pay after harvest', category: 'payment' });
    expect(r.status).toBe(201);
    expectConforms('POST', '/customers/{id}/notes', 201, r.body);
    expect((await fs.patch(`/notes/${r.body.id}`, { text: 'Will pay after the harvest' })).status).toBe(200);
    expect((await (await as(t, '01700000002')).patch(`/notes/${r.body.id}`, { text: 'not mine' })).status).toBe(404);
    t.clock.advance(16 * 60_000);
    const fs2 = await as(t, '01700000003');
    expect((await fs2.patch(`/notes/${r.body.id}`, { text: 'too late' })).status).toBe(409);
    expect((await fs2.get(`/customers/${ids['100245']}`)).body.recentNotes[0].text).toBe('Will pay after the harvest');
    expect((await fs2.post(`/customers/${ids['100248']}/notes`, { clientId: randomUUID(), text: 'not my customer' })).status).toBe(404);
    expect((await (await as(t, '01700000006')).post(`/customers/${ids['100245']}/notes`, { clientId: randomUUID(), text: 'viewer' })).status).toBe(403);
  });

  it('logs a call attempt idempotently', async () => {
    const fs = await as(t, '01700000003');
    const b = { clientId: randomUUID(), channel: 'call', phoneIndex: 0, at: '2026-11-15T04:10:00Z', durationSec: 42, outcome: 'connected' };
    const r = await fs.post(`/customers/${ids['100245']}/contact-attempts`, b);
    expect(r.status).toBe(201);
    expectConforms('POST', '/customers/{id}/contact-attempts', 201, r.body);
    expect((await fs.post(`/customers/${ids['100245']}/contact-attempts`, b)).status).toBe(200);
    const l = await fs.get(`/customers/${ids['100245']}/contact-attempts`);
    expectConforms('GET', '/customers/{id}/contact-attempts', 200, l.body);
    expect(l.body).toHaveLength(1);
    const tl = await fs.get(`/customers/${ids['100245']}/timeline`);
    expect(tl.body.items.map((i: { kind: string }) => i.kind)).toEqual(expect.arrayContaining(['note', 'contact_attempt', 'visit']));
  });

  it('logs a call to the guarantor (1.12.0) and says so on the timeline', async () => {
    const fs = await as(t, '01700000003');
    const r = await fs.post(`/customers/${ids['100246']}/contact-attempts`, { clientId: randomUUID(), channel: 'call', target: 'guarantor', at: '2026-11-15T04:20:00Z', outcome: 'no_answer' });
    expect(r.status).toBe(201);
    expectConforms('POST', '/customers/{id}/contact-attempts', 201, r.body);
    expect(r.body.target).toBe('guarantor');
    const plain = await fs.post(`/customers/${ids['100246']}/contact-attempts`, { clientId: randomUUID(), channel: 'call', at: '2026-11-15T04:21:00Z' });
    expect(plain.body.target).toBe('customer');
    expect((await fs.post(`/customers/${ids['100246']}/contact-attempts`, { clientId: randomUUID(), channel: 'call', target: 'neighbour', at: '2026-11-15T04:22:00Z' })).status).toBe(400);
    const tl = await fs.get(`/customers/${ids['100246']}/timeline`);
    const g = tl.body.items.find((i: { kind: string; data?: { target?: string } }) => i.kind === 'contact_attempt' && i.data?.target === 'guarantor');
    expect(g.summary.bn).toContain('জামিনদার');
    expect(g.summary.en).toContain('guarantor');
  });
});

describe('promises (FR-PRM-001..003)', () => {
  let first = '';
  it('validates the date range; new promise supersedes the old one', async () => {
    const fs = await as(t, '01700000003');
    const mk = (over: Record<string, unknown>) => fs.post('/promises', { clientId: randomUUID(), customerId: ids['100246'], promisedDate: '2026-11-16', promisedAmountPoisha: 350_000, ...over });
    expect((await mk({ promisedDate: '2026-11-14' })).body.details.rule).toBe('PROMISE_DATE_RANGE');
    expect((await mk({ promisedDate: '2027-02-01' })).body.details.rule).toBe('PROMISE_DATE_RANGE');
    const a = await mk({ promisedDate: '2026-11-15' });
    expect(a.status).toBe(201);
    expectConforms('POST', '/promises', 201, a.body);
    first = a.body.id;
    expect((await fs.get('/customers?filter=promised_today')).body.items.map((c: { id: string }) => c.id)).toEqual([ids['100246']]);
    const b = await mk({});
    expect(b.status).toBe(201);
    const all = await fs.get(`/promises?customerId=${ids['100246']}`);
    expect(all.body.items.find((p: { id: string }) => p.id === first).status).toBe('superseded');
    expect((await fs.get('/customers?filter=promised_today')).body.items).toHaveLength(0);
    expect((await fs.get('/customers')).body.items.find((c: { id: string }) => c.id === ids['100246']).openPromise.promisedDate).toBe('2026-11-16');
  });

  it('reminds on the day, keeps when ERP shows the payment, breaks otherwise', async () => {
    const fs = await as(t, '01700000003');
    const broken = await fs.post('/promises', { clientId: randomUUID(), customerId: ids['100245'], promisedDate: '2026-11-16', promisedAmountPoisha: 100_000 });
    const events: string[] = [];
    for (const e of ['promise.due', 'promise.kept', 'promise.broken']) t.ctx.bus.on(e, async () => void events.push(e));
    t.clock.advance(24 * 3_600_000); // 2026-11-16
    expect(await remindToday()).toBe(2);
    expect(await remindToday()).toBe(0);
    t.erp.officePayment('100246', '55100', 350_000);
    await deltaSync();
    expect(events).toContain('promise.kept');
    t.clock.advance(24 * 3_600_000); // 17th: still within grace
    expect(await evaluateDue()).toBe(0);
    t.clock.advance(24 * 3_600_000); // 18th
    expect(await evaluateDue()).toBe(1);
    const bm = await as(t, '01700000002');
    expect((await bm.get(`/promises?customerId=${ids['100245']}`)).body.items.find((p: { id: string }) => p.id === broken.body.id).status).toBe('broken');
    expect((await bm.get('/promises?status=kept')).body.items).toHaveLength(1);
  });
});

describe('admin-web contract additions (1.3.0)', () => {
  it('reads branch overrides and per-branch effective flags', async () => {
    const sa = await as(t, '01700000001');
    await sa.put(`/rbac/overrides/branch/${s.branchA}`, { role: 'field_staff', changes: [{ key: 'tag.set', effect: 'deny' }], reason: 'Pilot: managers tag only' });
    const o = await sa.get(`/rbac/overrides/branch/${s.branchA}`);
    expect(o.status).toBe(200);
    expectConforms('GET', '/rbac/overrides/branch/{branchId}', 200, o.body);
    expect(o.body.items).toEqual([expect.objectContaining({ role: 'field_staff', key: 'tag.set', effect: 'deny' })]);
    await setFlagSystem('module.tags', true, [{ branchId: s.branchB, enabled: false }]);
    const f = await sa.get(`/feature-flags/effective?branchId=${s.branchB}`);
    expectConforms('GET', '/feature-flags/effective', 200, f.body);
    expect(f.body.flags['module.tags']).toBe(false);
    expect((await sa.get(`/feature-flags/effective?branchId=${s.branchA}`)).body.flags['module.tags']).toBe(true);
    expect((await (await as(t, '01700000002')).get(`/feature-flags/effective?branchId=${s.branchA}`)).status).toBe(403);
  });
});

describe('admin list refs and range filters (contract 1.4.0)', () => {
  it('visits and promises lists carry display refs and filter by range', async () => {
    const bm = await as(t, '01700000002');
    const v = await bm.get('/visits?from=2026-11-15&to=2026-11-15&outcome=not_home');
    expect(v.status).toBe(200);
    expectConforms('GET', '/visits', 200, v.body);
    expect(v.body.items.length).toBeGreaterThan(0);
    expect(v.body.items[0].customer.code).toBeTruthy();
    expect(v.body.items[0].user.name).toBeTruthy();
    expect(v.body.items.every((x: { outcome: string }) => x.outcome === 'not_home')).toBe(true);
    expect((await bm.get('/visits?from=2026-11-16')).body.items).toEqual([]);
    expect((await bm.get('/visits?outcome=nope')).status).toBe(400);
    const p = await bm.get('/promises?from=2026-01-01&to=2030-01-01');
    expectConforms('GET', '/promises', 200, p.body);
    expect(p.body.items.length).toBeGreaterThan(0);
    expect(p.body.items[0].customer.name).toBeTruthy();
    expect(p.body.items[0].owner.name).toBeTruthy();
    expect((await bm.get('/promises?to=2020-01-01')).body.items).toEqual([]);
  });
});
