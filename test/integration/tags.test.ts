import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { applyAssignments, getByErpId } from '../../src/modules/customers/index.js';
import { setSystem } from '../../src/modules/settings/index.js';

let t: TestApp;
let s: Seeded;
const ids: Record<string, string> = {};

beforeAll(async () => {
  t = await createTestApp();
  s = await seedBasics(t);
  await deltaSync();
  for (const e of ['100245', '100246', '100248', '200301']) ids[e] = (await getByErpId(e))!.id;
  await applyAssignments([
    { customerId: ids['100245']!, assigneeId: s.fs1.id },
    { customerId: ids['100246']!, assigneeId: s.fs1.id },
    { customerId: ids['100248']!, assigneeId: s.fs1.id },
  ]);
});
afterAll(async () => t.close());

const tagBody = { state: 'tagged', severity: 'bad', reasonCode: 'plan_ended_unpaid', reason: 'Plan ended in October, refuses to pay' };

describe('tag / untag (FR-TAG-003/006)', () => {
  it('field staff tags with reason; contract conforms; list shows tagged badge', async () => {
    const c = await as(t, '01700000003');
    const r = await c.put(`/customers/${ids['100245']}/tag`, { ...tagBody, geo: { lat: 22.71, lng: 90.37, accuracyM: 10 } });
    expect(r.status).toBe(200);
    expectConforms('PUT', '/customers/{id}/tag', 200, r.body);
    expect(r.body.tag).toMatchObject({ state: 'tagged', severity: 'bad', setBy: s.fs1.id });
    const list = await c.get('/customers?filter=tagged_bad');
    expect(list.body.items.map((x: { id: string }) => x.id)).toEqual([ids['100245']]);
    expect(list.body.items[0].badges).toContain('tagged_bad');
  });

  it('rejects short reason (400), wrong reason code and no-op (422)', async () => {
    const c = await as(t, '01700000003');
    expect((await c.put(`/customers/${ids['100245']}/tag`, { ...tagBody, reason: 'short' })).status).toBe(400);
    expect((await c.put(`/customers/${ids['100245']}/tag`, { ...tagBody, reasonCode: 'cleared' })).body.details.rule).toBe('REASON_CODE_MISMATCH');
    expect((await c.put(`/customers/${ids['100245']}/tag`, tagBody)).body.details.rule).toBe('NO_CHANGE');
  });

  it('If-Match with a stale version is 412', async () => {
    const c = await as(t, '01700000003');
    const r = await c.put(`/customers/${ids['100246']}/tag`, tagBody, { 'if-match': 'W/"1"' });
    expect(r.status).toBe(412);
  });

  it('out-of-scope customer is 404; viewer cannot tag (403)', async () => {
    expect((await (await as(t, '01700000003')).put(`/customers/${ids['200301']}/tag`, tagBody)).status).toBe(404);
    expect((await (await as(t, '01700000006')).put(`/customers/${ids['100246']}/tag`, tagBody)).status).toBe(403);
  });

  it('history is immutable and newest first', async () => {
    const bm = await as(t, '01700000002');
    await bm.put(`/customers/${ids['100245']}/tag`, { ...tagBody, severity: 'legal', reasonCode: 'other', reason: 'Handed to legal recovery team' });
    const h = await bm.get(`/customers/${ids['100245']}/tag-history`);
    expect(h.status).toBe(200);
    expectConforms('GET', '/customers/{id}/tag-history', 200, h.body);
    expect(h.body).toHaveLength(2);
    expect(h.body[0].next.severity).toBe('legal');
    expect(h.body[0].previous.severity).toBe('bad');
    expect(h.body[1]).toMatchObject({ source: 'app', actor: { id: s.fs1.id, role: 'field_staff' }, deviceLocation: { lat: 22.71 } });
  });
});

describe('approval mode (FR-TAG-007)', () => {
  let eventId = '';
  it('staff tag becomes pending and lands in the review queue', async () => {
    await setSystem('tags.requireApproval', true);
    const c = await as(t, '01700000003');
    const r = await c.put(`/customers/${ids['100246']}/tag`, { ...tagBody, reasonCode: 'refused_to_pay', reason: 'Refused twice this month' });
    expect(r.body.tag.state).toBe('pending');
    eventId = r.body.eventId;
    const q = await (await as(t, '01700000002')).get('/tags/review-queue');
    expect(q.body.items.find((i: { eventId: string }) => i.eventId === eventId)).toMatchObject({ kind: 'approval', requested: { state: 'tagged' } });
    // pending is not "tagged" for filters
    expect((await c.get('/customers?filter=tagged_bad')).body.items.map((x: { id: string }) => x.id)).not.toContain(ids['100246']);
  });

  it('staff cannot decide (403); manager approves once (second is 409)', async () => {
    expect((await (await as(t, '01700000003')).post(`/tags/review-queue/${eventId}/decision`, { decision: 'approve' })).status).toBe(403);
    const bm = await as(t, '01700000002');
    const d = await bm.post(`/tags/review-queue/${eventId}/decision`, { decision: 'approve' });
    expect(d.status).toBe(200);
    expect(d.body.tag.state).toBe('tagged');
    expect((await bm.post(`/tags/review-queue/${eventId}/decision`, { decision: 'approve' })).status).toBe(409);
    await setSystem('tags.requireApproval', false);
  });
});

describe('balance cleared (FR-TAG-005)', () => {
  it('a tagged customer whose balance clears gets one review; approve untags', async () => {
    const fs = await as(t, '01700000003');
    await fs.put(`/customers/${ids['100248']}/tag`, { ...tagBody, severity: 'watch', reasonCode: 'repeated_broken_promise', reason: 'Broke three promises in a row' });
    const events: unknown[] = [];
    t.ctx.bus.on('tag.review_requested', async (p) => void events.push(p));
    t.erp.officePayment('100248', '54500', 1);
    t.erp.officePayment('100248', '55300', 6300000);
    await deltaSync();
    await deltaSync(); // no duplicate review
    expect(events).toHaveLength(1);
    const bm = await as(t, '01700000002');
    const q = await bm.get('/tags/review-queue');
    const item = q.body.items.find((i: { kind: string; customer: { id: string } }) => i.kind === 'balance_cleared' && i.customer.id === ids['100248']);
    expect(item.customer.tag.state).toBe('tagged'); // tag remains until reviewed
    const det = await bm.get(`/customers/${ids['100248']}`);
    expect(det.body.badSuggestion).toBeNull(); // suggestion disappears
    const d = await bm.post(`/tags/review-queue/${item.eventId}/decision`, { decision: 'approve' });
    expect(d.body.tag.state).toBe('none');
    const h = await bm.get(`/customers/${ids['100248']}/tag-history`);
    expect(h.body.map((e: { kind: string }) => e.kind)).toEqual(['decision', 'review_requested', 'change']);
  });
});
