import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, seedBasics, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { getByErpId } from '../../src/modules/customers/index.js';
import { manifest as customersManifest } from '../../src/modules/customers/manifest.js';
import { refeedTaggedCustomers } from '../../src/modules/customers/service.js';
import { runMigrations } from '../../src/core/db/migrations.js';

/**
 * FR-TAG-010 / ADR-070 (owner request 2026-11-26): staff-app schema 20 stores tag.reasonCode, but phones only learn
 * it when a customer comes through the feed again. Migration customers/20261126-0002-refeed-tagged-customers sends
 * every tagged customer once as an ordinary delta: no 410, no bootstrap, customers only.
 */
let t: TestApp;
const ids: Record<string, string> = {};
type Change = { entity: string; op: string; id: string; data?: { tag?: { state: string; severity?: string; reasonCode?: string } } };

async function pull(phone: string, cursor: string) {
  const c = await as(t, phone);
  const changes: Change[] = [];
  let cur = cursor;
  for (;;) {
    const r = await c.get(`/sync/pull?cursor=${cur}&limit=200`);
    expect(r.status).toBe(200);
    expectConforms('GET', '/sync/pull', 200, r.body);
    changes.push(...r.body.changes);
    cur = r.body.nextCursor;
    if (!r.body.hasMore) break;
  }
  return { customers: changes.filter((x) => x.entity === 'customer'), all: changes, next: cur };
}

const cursorOf = async (phone: string) => (await (await as(t, phone)).get('/sync/bootstrap?limit=200')).body.pullCursor as string;

beforeAll(async () => {
  t = await createTestApp();
  await seedBasics(t);
  await deltaSync();
  for (const e of ['100245', '100246', '200301']) ids[e] = (await getByErpId(e))!.id;
  // Tagged by someone else (branch manager / super admin) before the phones stored reasonCode.
  await (await as(t, '01700000002')).put(`/customers/${ids['100245']}/tag`, { state: 'tagged', severity: 'legal', reasonCode: 'other', reason: 'Handed to legal recovery team' });
  await (await as(t, '01700000001')).put(`/customers/${ids['200301']}/tag`, { state: 'tagged', severity: 'bad', reasonCode: 'refused_to_pay', reason: 'Refused twice this month' });
});
afterAll(async () => t.close());

describe('one-off re-send of tagged customers (FR-TAG-010)', () => {
  it('runs once: applied at boot, skipped on later boots', async () => {
    const set = [{ module: 'customers', migrations: customersManifest.migrations ?? [] }];
    expect(set[0]!.migrations.map((m) => m.id)).toContain('20261126-0002-refeed-tagged-customers');
    expect(await runMigrations(set)).toEqual([]);
  });

  it('a device whose cursor predates the migration gets its tagged customers with tag.reasonCode, then only deltas', async () => {
    // Field staff of BRL01, not the assignee: holds the branch's customers since before the deploy.
    const old = await cursorOf('01700000004');
    expect((await pull('01700000004', old)).customers).toEqual([]);

    // Deploy: the migration's work (the boot run had an empty database, nothing to send).
    expect(await refeedTaggedCustomers()).toBe(2);

    const first = await pull('01700000004', old); // no 410: ordinary pull, outbox untouched
    expect(first.customers.map((c) => c.id)).toEqual([ids['100245']]); // tagged only, own branch only
    expect(first.customers[0]).toMatchObject({ op: 'upsert', data: { tag: { state: 'tagged', severity: 'legal', reasonCode: 'other' } } });
    expect(first.all.every((c) => c.entity === 'customer')).toBe(true); // customers only

    // After that, only deltas again.
    const again = await pull('01700000004', first.next);
    expect(again.customers).toEqual([]);
    await (await as(t, '01700000002')).put(`/customers/${ids['100246']}/tag`, { state: 'tagged', severity: 'bad', reasonCode: 'refused_to_pay', reason: 'Refused twice this month' });
    const delta = await pull('01700000004', again.next);
    expect(delta.customers.map((c) => c.id)).toEqual([ids['100246']]);
    expect(delta.customers[0]!.data!.tag).toMatchObject({ reasonCode: 'refused_to_pay' });
  });

  it('scope applies: the other branch gets its own tagged customer, never BRL01 ones', async () => {
    const r = await pull('01700000005', 's_0');
    const tagged = r.customers.filter((c) => c.data?.tag?.state === 'tagged');
    expect(tagged.map((c) => c.id)).toEqual([ids['200301']]);
    expect(r.customers.some((c) => c.id === ids['100245'] && c.op === 'upsert')).toBe(false);
  });

  it('a device that bootstrapped after the deploy gets nothing extra', async () => {
    const fresh = await cursorOf('01700000003');
    expect((await pull('01700000003', fresh)).customers).toEqual([]);
  });

  it('pull without a token is 401', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/sync/pull?cursor=s_0' })).statusCode).toBe(401);
  });
});
