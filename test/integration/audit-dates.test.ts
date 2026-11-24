import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, client, createTestApp, login, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { record } from '../../src/modules/audit/index.js';

/** FR-AUD-003 (1.48.0): GET /audit `from` / `to` take inclusive Asia/Dhaka business dates, with every other filter. */
let t: TestApp;
let s: Seeded;
const SA = '01700000001';

/** An entry written at a UTC instant (the clock moves; audit stamps `at` from it). */
async function entryAt(utc: string, action: string, branchId: string) {
  t.clock.set(utc);
  await record({ actor: { id: s.sa.id, role: 'super_admin', name: 'Owner' }, action, entity: 'test', entityId: `${action}@${utc}`, branchId });
}
const actions = (body: { items: { action: string; entityId: string }[] }) => body.items.map((i) => i.entityId).filter((x) => x.startsWith('t.'));

beforeAll(async () => {
  t = await createTestApp({ now: '2026-11-15T04:00:00Z' });
  s = await seedBasics(t);
  // Dhaka midnight is 18:00 UTC: 17:59:59Z on the 13th is still the 13th in Dhaka, 18:00Z is already the 14th.
  await entryAt('2026-11-13T17:59:59.999Z', 't.before', s.branchA);
  await entryAt('2026-11-13T18:00:00.000Z', 't.first', s.branchA);
  await entryAt('2026-11-14T06:00:00.000Z', 't.mid', s.branchB);
  await entryAt('2026-11-14T17:59:59.999Z', 't.last', s.branchA);
  await entryAt('2026-11-14T18:00:00.000Z', 't.after', s.branchA);
  t.clock.set('2026-11-15T04:00:00Z');
});
afterAll(async () => t.close());

describe('GET /audit with Dhaka business dates', () => {
  it('from = to = one Dhaka day covers exactly 00:00–23:59:59.999 Dhaka (across 18:00 UTC)', async () => {
    const sa = client(t.app, (await login(t.app, SA, { client: 'web' })).accessToken);
    const r = await sa.get('/audit?from=2026-11-14&to=2026-11-14&entity=test&limit=100');
    expect(r.status).toBe(200);
    expectConforms('GET', '/audit', 200, r.body);
    expect(actions(r.body).map((x) => x.split('@')[0])).toEqual(['t.last', 't.mid', 't.first']);
  });

  it('open ranges, several days, and a date mixed with a date-time', async () => {
    const sa = await as(t, SA);
    expect(actions((await sa.get('/audit?from=2026-11-14&entity=test&limit=100')).body).map((x) => x.split('@')[0])).toEqual(['t.after', 't.last', 't.mid', 't.first']);
    expect(actions((await sa.get('/audit?to=2026-11-13&entity=test&limit=100')).body).map((x) => x.split('@')[0])).toEqual(['t.before']);
    expect(actions((await sa.get('/audit?from=2026-11-13&to=2026-11-15&entity=test&limit=100')).body)).toHaveLength(5);
    // A date-time still means that exact instant (unchanged before 1.48.0).
    expect(actions((await sa.get('/audit?from=2026-11-14T06:00:00Z&to=2026-11-14&entity=test&limit=100')).body).map((x) => x.split('@')[0])).toEqual(['t.last', 't.mid']);
  });

  it('combines with the other filters and the caller scope', async () => {
    const sa = await as(t, SA);
    const byBranch = await sa.get(`/audit?from=2026-11-14&to=2026-11-14&branchId=${s.branchB}&entity=test`);
    expect(actions(byBranch.body).map((x) => x.split('@')[0])).toEqual(['t.mid']);
    const byAction = await sa.get('/audit?from=2026-11-14&to=2026-11-14&action=t.l*');
    expect(actions(byAction.body).map((x) => x.split('@')[0])).toEqual(['t.last']);
    const byActor = await sa.get(`/audit?from=2026-11-14&to=2026-11-14&actorId=${s.sa.id}&entity=test`);
    expect(actions(byActor.body)).toHaveLength(3);
    // The viewer of branch A (audit.view) never sees branch B, dates or not.
    const vw = client(t.app, (await login(t.app, '01700000006', { client: 'web' })).accessToken);
    const scoped = await vw.get('/audit?from=2026-11-14&to=2026-11-14&entity=test');
    expect(scoped.status).toBe(200);
    expect(actions(scoped.body).map((x) => x.split('@')[0])).toEqual(['t.last', 't.first']);
  });

  it('400 for a bad date or from after to; 401 without a token; 403 without audit.view', async () => {
    const sa = await as(t, SA);
    for (const q of ['from=2026-13-01', 'to=yesterday', 'from=2026-11-15&to=2026-11-14', 'from=2026-11-14T10:00:00Z&to=2026-11-14T09:00:00Z']) {
      const r = await sa.get(`/audit?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.body.code).toBe('VALIDATION_FAILED');
      expectConforms('GET', '/audit', 400, r.body);
    }
    expect((await client(t.app).get('/audit?from=2026-11-14')).status).toBe(401);
    const fs = await as(t, '01700000003');
    const r = await fs.get('/audit?from=2026-11-14');
    expect(r.status).toBe(403);
    expectConforms('GET', '/audit', 403, r.body);
  });
});
