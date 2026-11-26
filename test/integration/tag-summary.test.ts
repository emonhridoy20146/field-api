import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { applyAssignments, getByErpId } from '../../src/modules/customers/index.js';
import { setSystem } from '../../src/modules/settings/index.js';
import { CustomerModel } from '../../src/modules/customers/models/customer.model.js';

/**
 * Contract 1.52.0 (FR-TAG-009, owner request 2026-11-26): map pins and customer hits of global search carry the tag
 * summary { state, severity, reasonCode } so every list can draw the bad-tag border with a colour per reason.
 */
let t: TestApp;
let s: Seeded;
const ids: Record<string, string> = {};
const WIDE = '/customers/map?bbox=88,20,93,27&zoom=15';

type Pin = { id: string; tagged: boolean; tag?: { state: string; severity?: string; reasonCode?: string } };
type Hit = { type: string; id: string; tag?: Pin['tag'] };

beforeAll(async () => {
  t = await createTestApp();
  s = await seedBasics(t);
  await deltaSync();
  for (const e of ['100245', '100246', '100248', '200301']) ids[e] = (await getByErpId(e))!.id;
  await applyAssignments([
    { customerId: ids['100245']!, assigneeId: s.fs1.id },
    { customerId: ids['100246']!, assigneeId: s.fs1.id },
  ]);
  // the fixture has no usable pin for these two; give them one so they appear on the map
  for (const e of ['100246', '100248']) await CustomerModel.updateOne({ _id: ids[e] }, { $set: { location: { type: 'Point', coordinates: [90.371, 22.712] } } });
  const bm = await as(t, '01700000002');
  await bm.put(`/customers/${ids['100245']}/tag`, { state: 'tagged', severity: 'legal', reasonCode: 'other', reason: 'Handed to legal recovery team' });
  // other branch (PTK01): tagged by the super admin, out of scope for the BRL01 manager
  const sa = await as(t, '01700000001');
  await sa.put(`/customers/${ids['200301']}/tag`, { state: 'tagged', severity: 'bad', reasonCode: 'refused_to_pay', reason: 'Refused twice this month' });
  // approval mode: a staff tag stays pending
  await setSystem('tags.requireApproval', true);
  await (await as(t, '01700000003')).put(`/customers/${ids['100246']}/tag`, { state: 'tagged', severity: 'bad', reasonCode: 'refused_to_pay', reason: 'Refused twice this month' });
  await setSystem('tags.requireApproval', false);
});
afterAll(async () => t.close());

describe('MapPin.tag (1.52.0)', () => {
  it('carries severity and reasonCode for tagged, state only for pending / none; conforms', async () => {
    const r = await (await as(t, '01700000002')).get(WIDE);
    expect(r.status).toBe(200);
    expectConforms('GET', '/customers/map', 200, r.body);
    const pins = new Map((r.body.pins as Pin[]).map((p) => [p.id, p]));
    expect(pins.get(ids['100245']!)).toMatchObject({ tagged: true, tag: { state: 'tagged', severity: 'legal', reasonCode: 'other' } });
    expect(pins.get(ids['100246']!)!.tag).toEqual({ state: 'pending' });
    expect(pins.get(ids['100246']!)!.tagged).toBe(false);
    expect(pins.get(ids['100248']!)!.tag).toEqual({ state: 'none' });
  });

  it('does not return out-of-scope customers or their tags', async () => {
    const bm = await (await as(t, '01700000002')).get(WIDE);
    expect((bm.body.pins as Pin[]).some((p) => p.id === ids['200301'])).toBe(false);
    expect(JSON.stringify(bm.body)).not.toContain('refused_to_pay');
    const sa = await (await as(t, '01700000001')).get(WIDE);
    expect((sa.body.pins as Pin[]).find((p) => p.id === ids['200301'])!.tag).toEqual({ state: 'tagged', severity: 'bad', reasonCode: 'refused_to_pay' });
  });

  it('401 without a token, 400 on a bad bbox', async () => {
    expect((await t.app.inject({ method: 'GET', url: `/api/v1${WIDE}` })).statusCode).toBe(401);
    expect((await (await as(t, '01700000002')).get('/customers/map?bbox=nope')).status).toBe(400);
  });
});

describe('GET /search customer tag (1.52.0)', () => {
  it('customer hits carry the tag summary; other hit types do not; conforms', async () => {
    const bm = await as(t, '01700000002');
    const r = await bm.get('/search?q=100245&types=customer');
    expect(r.status).toBe(200);
    expectConforms('GET', '/search', 200, r.body);
    expect((r.body as Hit[]).find((h) => h.id === ids['100245'])).toMatchObject({ type: 'customer', tag: { state: 'tagged', severity: 'legal', reasonCode: 'other' } });
    const pending = await bm.get('/search?q=100246&types=customer');
    expect((pending.body as Hit[]).find((h) => h.id === ids['100246'])!.tag).toEqual({ state: 'pending' });
    const users = await bm.get('/search?q=FS014&types=user');
    expectConforms('GET', '/search', 200, users.body);
    expect((users.body as Hit[]).length).toBeGreaterThan(0);
    expect((users.body as Hit[]).every((h) => h.tag === undefined)).toBe(true);
  });

  it('out-of-scope customer is absent (no tag leak); in scope for the super admin', async () => {
    const bm = await (await as(t, '01700000002')).get('/search?q=200301&types=customer');
    expect(bm.status).toBe(200);
    expect((bm.body as Hit[]).some((h) => h.id === ids['200301'])).toBe(false);
    const sa = await (await as(t, '01700000001')).get('/search?q=200301&types=customer');
    expect((sa.body as Hit[]).find((h) => h.id === ids['200301'])!.tag).toEqual({ state: 'tagged', severity: 'bad', reasonCode: 'refused_to_pay' });
  });

  it('401 without a token, 400 on a short query', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/search?q=100245' })).statusCode).toBe(401);
    expect((await (await as(t, '01700000002')).get('/search?q=a')).status).toBe(400);
  });
});
