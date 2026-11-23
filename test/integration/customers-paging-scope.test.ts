import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { CustomerModel } from '../../src/modules/customers/models/customer.model.js';
import { N_A, N_B, seedDoc, walk, type Client, type PagingRow as Row } from '../helpers/customer-seed.js';

/**
 * Contract 1.46.0: `offset` with every filter, the exact total, and auth / scope (own file: the global
 * rate limit of 100 requests a minute is per app). A seeded set of 1,250 customers in branch A and 30 in branch B.
 */
let t: TestApp;
let s: Seeded;
beforeAll(async () => {
  t = await createTestApp();
  s = await seedBasics(t);
  await CustomerModel.insertMany([
    ...Array.from({ length: N_A }, (_, i) => seedDoc(i, s.branchA, 'A', s.fs1.id)),
    ...Array.from({ length: N_B }, (_, i) => seedDoc(i, s.branchB, 'B', s.fs1.id)),
  ]);
}, 60_000);
afterAll(async () => t.close());

const clients = new Map<string, Promise<Client>>();
/** One login per user for the whole file: the global limit is 100 requests a minute and must stay. */
const user = (phone: string) => clients.get(phone) ?? clients.set(phone, as(t, phone)).get(phone)!;

describe('GET /customers offset with filters (contract 1.46.0)', () => {
  it('offset with filters: status filter, payState, invoiceKind, assignedTo, search; total matches the walk', async () => {
    const bm = await user('01700000002');
    for (const query of [
      'filter=overdue',
      'filter=paid_up',
      'payState=missed_one',
      'invoiceKind=credit',
      `assignedTo=${s.fs1.id}`,
      'filter=unassigned&sort=name',
      'q=Customer%2001',
    ]) {
      const head = await bm.get(`/customers?${query}&limit=1&includeTotal=true`);
      expect(head.status).toBe(200);
      const all = await walk(bm, query, 100);
      expect(all.length).toBe(head.body.total);
      expect(new Set(all).size).toBe(all.length);
      if (all.length > 100) {
        const p2 = await bm.get(`/customers?${query}&limit=100&offset=100`);
        expect(p2.body.items.map((x: Row) => x.id)).toEqual(all.slice(100, 200));
      }
    }
    const overdue = await bm.get('/customers?filter=overdue&limit=1000&offset=0');
    expect(overdue.body.items.length).toBeGreaterThan(0);
    expect(overdue.body.items.every((x: Row) => x.daysOverdue > 0)).toBe(true);
  });

  it('includeTotal counts every match exactly (no longer capped at 10,000)', async () => {
    const sa = await user('01700000001');
    const r = await sa.get('/customers?limit=1&includeTotal=true');
    expect(r.body.total).toBe(N_A + N_B);
  });
});

describe('GET /customers offset: auth and scope (1.46.0)', () => {
  it('401 without a token', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/customers?limit=1000&offset=100' })).statusCode).toBe(
      401,
    );
  });

  it('403 when customer.view is denied', async () => {
    const sa = await user('01700000001');
    expect(
      (
        await sa.put(`/rbac/overrides/user/${s.vw.id}`, {
          changes: [{ key: 'customer.view', effect: 'deny' }],
          reason: 'paging test',
        })
      ).status,
    ).toBe(200);
    expect((await (await user('01700000006')).get('/customers?limit=1000&offset=0')).status).toBe(403);
    await sa.put(`/rbac/overrides/user/${s.vw.id}`, {
      changes: [{ key: 'customer.view', effect: 'inherit' }],
      reason: 'paging test',
    });
    expect((await (await user('01700000006')).get('/customers?limit=10&offset=0')).status).toBe(200);
  });

  it('offset never reaches outside the scope: branch B staff see only branch B, branch A manager gets nothing for branch B', async () => {
    const fsB = await user('01700000005');
    const r = await fsB.get('/customers?limit=1000&offset=0&includeTotal=true');
    expect(r.body.total).toBe(N_B);
    expect(r.body.items.every((x: Row) => x.erpCustomerId.startsWith('B'))).toBe(true);
    expect((await fsB.get('/customers?limit=1000&offset=10')).body.items).toHaveLength(N_B - 10);
    const bm = await user('01700000002');
    const other = await bm.get(`/customers?branchId=${s.branchB}&limit=1000&offset=0&includeTotal=true`);
    expect(other.status).toBe(200);
    expect(other.body.items).toEqual([]);
    expect(other.body.total).toBe(0);
    const own = await bm.get('/customers?limit=1000&offset=1000&includeTotal=true');
    expect(own.body.total).toBe(N_A);
    expect(own.body.items.every((x: Row) => x.erpCustomerId.startsWith('A'))).toBe(true);
  });
});
