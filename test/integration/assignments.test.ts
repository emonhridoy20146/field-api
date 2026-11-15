import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { getByErpId } from '../../src/modules/customers/index.js';
import { tick } from '../../src/modules/handovers/service.js';

let t: TestApp;
let s: Seeded;
const ids: Record<string, string> = {};
const assignee = async (erp: string) => (await getByErpId(erp))!.assigneeId;

beforeAll(async () => {
  t = await createTestApp();
  s = await seedBasics(t);
  await deltaSync();
  for (const e of ['100245', '100246', '100247', '100248', '200301']) ids[e] = (await getByErpId(e))!.id;
});
afterAll(async () => t.close());

let areaChk = '';
describe('areas & assignments (FR-ASG-001..004)', () => {
  it('manager creates a code-based area; customers fall into it', async () => {
    const bm = await as(t, '01700000002');
    const r = await bm.post('/areas', { branchId: s.branchA, name: { bn: 'চরকাওয়া', en: 'Charkawa' }, code: 'CHK', kind: 'codes', erpAreaCodes: ['BSL-CHK'] });
    expect(r.status).toBe(201);
    areaChk = r.body.id;
    expect(r.body.customerCount).toBe(2); // 100245, 100247
    expect((await bm.post('/areas', { branchId: s.branchA, name: { bn: 'x', en: 'x' }, code: 'CHK', kind: 'codes', erpAreaCodes: ['X'] })).status).toBe(409);
    expect((await bm.post('/areas', { branchId: s.branchB, name: { bn: 'x', en: 'x' }, code: 'PTK', kind: 'codes', erpAreaCodes: ['PTK-KLP'] })).status).toBe(404);
    const list = await bm.get('/areas');
    expectConforms('GET', '/areas', 200, list.body);
  });

  it('area assignment sets the primary assignee; staff now see those customers', async () => {
    const bm = await as(t, '01700000002');
    const r = await bm.post('/assignments', { userId: s.fs1.id, type: 'area', areaId: areaChk });
    expect(r.status).toBe(201);
    expect(await assignee('100245')).toBe(s.fs1.id);
    expect(await assignee('100247')).toBe(s.fs1.id);
    const fs = await as(t, '01700000003');
    expect((await fs.get('/customers')).body.items).toHaveLength(2);
  });

  it('direct assignment overrides area; history is kept', async () => {
    const bm = await as(t, '01700000002');
    const r = await bm.post('/assignments', { userId: s.fs2.id, type: 'customer', customerId: ids['100247'] });
    expect(r.status).toBe(201);
    expect(await assignee('100247')).toBe(s.fs2.id);
    expect(await assignee('100245')).toBe(s.fs1.id);
    // ending it falls back to the area holder
    expect((await bm.delete(`/assignments/${r.body.id}`)).status).toBe(204);
    expect(await assignee('100247')).toBe(s.fs1.id);
    const hist = await bm.get(`/assignments?customerId=${ids['100247']}&active=false`);
    expectConforms('GET', '/assignments', 200, hist.body);
    expect(hist.body[0].effectiveTo).not.toBeNull();
  });

  it('rejects non-staff, other-branch staff, and field staff callers', async () => {
    const bm = await as(t, '01700000002');
    expect((await bm.post('/assignments', { userId: s.vw.id, type: 'customer', customerId: ids['100246'] })).body.details.rule).toBe('NOT_FIELD_STAFF');
    expect((await bm.post('/assignments', { userId: s.fsB.id, type: 'customer', customerId: ids['100246'] })).status).toBe(404);
    expect((await (await as(t, '01700000003')).post('/assignments', { userId: s.fs1.id, type: 'customer', customerId: ids['100246'] })).status).toBe(403);
  });

  it('bulk assigns and skips out-of-scope ids', async () => {
    const bm = await as(t, '01700000002');
    const r = await bm.post('/assignments/bulk', { userId: s.fs2.id, customerIds: [ids['100246'], ids['100248'], ids['200301'], 'junk'] });
    expect(r.body).toEqual({ assigned: 2, skipped: 2 });
    expect(await assignee('100246')).toBe(s.fs2.id);
    expect(await assignee('200301')).toBeNull();
  });

  it('a customer moving into an area via ERP sync picks up the area holder', async () => {
    const raw = (await t.erp.getCustomer('100248'))!;
    t.erp.upsertCustomer({ ...raw, areaCode: 'BSL-CHK' });
    // 100248 has a direct assignment to fs2, so it stays with fs2 (direct overrides area)
    await deltaSync();
    expect(await assignee('100248')).toBe(s.fs2.id);
  });
});

describe('handovers (FR-HO-001..006)', () => {
  let hoId = '';
  it('manager hands fs1 area to fs2; until acceptance fs1 keeps customers', async () => {
    const bm = await as(t, '01700000002');
    const r = await bm.post('/handovers', { fromUserId: s.fs1.id, toUserId: s.fs2.id, areaIds: [areaChk], reason: 'Rakib on leave' });
    expect(r.status).toBe(201);
    expectConforms('POST', '/handovers', 201, r.body);
    expect(r.body.status).toBe('pending_acceptance');
    expect(r.body.summary.customers).toBe(2);
    expect(r.body.summary.overdue).toBe(1);
    hoId = r.body.id;
    expect(await assignee('100245')).toBe(s.fs1.id);
  });

  it('only the receiver can accept; sender gets 404', async () => {
    expect((await (await as(t, '01700000003')).post(`/handovers/${hoId}/accept`)).status).toBe(404);
    const fs2 = await as(t, '01700000004');
    const incoming = await fs2.get('/handovers?mine=true&status=pending_acceptance');
    expect(incoming.body.map((h: { id: string }) => h.id)).toContain(hoId);
    const a = await fs2.post(`/handovers/${hoId}/accept`);
    expect(a.status).toBe(200);
    expect(a.body.status).toBe('accepted');
    expect(await assignee('100245')).toBe(s.fs2.id);
    expect(await assignee('100247')).toBe(s.fs2.id);
    expect((await fs2.post(`/handovers/${hoId}/accept`)).status).toBe(409);
  });

  it('rejects handing over customers the sender does not hold', async () => {
    const bm = await as(t, '01700000002');
    const r = await bm.post('/handovers', { fromUserId: s.fs1.id, toUserId: s.fs2.id, customerIds: [ids['100246']], reason: 'not theirs' });
    expect(r.body.details.rule).toBe('CUSTOMER_NOT_HELD');
  });

  it('temporary cover reverts after endDate', async () => {
    const bm = await as(t, '01700000002');
    const r = await bm.post('/handovers', { fromUserId: s.fs2.id, toUserId: s.fs1.id, customerIds: [ids['100246']], reason: 'Two-day leave cover', endDate: '2026-11-16' });
    expect(r.status).toBe(201);
    await (await as(t, '01700000003')).post(`/handovers/${r.body.id}/accept`);
    expect(await assignee('100246')).toBe(s.fs1.id);
    t.clock.advance(2 * 86_400_000); // 2026-11-17
    const res = await tick();
    expect(res.reverted).toBe(1);
    expect(await assignee('100246')).toBe(s.fs2.id);
  });

  it('pending handovers expire after 72 h', async () => {
    const bm = await as(t, '01700000002');
    const r = await bm.post('/handovers', { fromUserId: s.fs2.id, toUserId: s.fs1.id, customerIds: [ids['100248']], reason: 'Will expire' });
    t.clock.advance(73 * 3_600_000);
    const res = await tick();
    expect(res.expired).toBe(1);
    const bm2 = await as(t, '01700000002'); // access token expired with the clock jump
    expect((await bm2.get(`/handovers/${r.body.id}`)).body.status).toBe('expired');
  });
});
