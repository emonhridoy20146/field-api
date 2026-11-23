import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { CustomerModel } from '../../src/modules/customers/models/customer.model.js';
import { LIST_PROJECTION } from '../../src/modules/customers/service.js';
import { N_A, N_B, seedDoc, walk, type Client, type PagingRow as Row } from '../helpers/customer-seed.js';

/**
 * Contract 1.46.0: GET /customers takes limit up to 1000 and a 0-based `offset` (admin-web numbered pager,
 * page sizes 100 / 500 / 1000). A seeded set of 1,250 customers in branch A and 30 in branch B.
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

const SORTS = ['-daysOverdue', 'name', '-totalOutstanding', 'nextDueDate'] as const;

describe('GET /customers limit 1000 and offset (contract 1.46.0)', () => {
  it('a 1000-row page: conforms, has nextCursor and the exact total, stays small and fast', async () => {
    const bm = await user('01700000002');
    const started = Date.now();
    const r = await bm.get('/customers?limit=1000&includeTotal=true');
    const ms = Date.now() - started;
    expect(r.status).toBe(200);
    expectConforms('GET', '/customers', 200, r.body);
    expect(r.body.items).toHaveLength(1000);
    expect(r.body.total).toBe(N_A);
    expect(r.body.nextCursor).toBeTruthy();
    // No ERP plan schedules, guarantor or risk snapshot in a list row.
    const bytes = Buffer.byteLength(JSON.stringify(r.body));
    expect(bytes).toBeLessThan(2_000_000);
    expect(JSON.stringify(r.body)).not.toContain('Fake Guarantor');
    // Generous bound for CI: the point is no in-memory sort or full-document load, checked precisely below.
    expect(ms).toBeLessThan(10_000);
    // The default sort is still most overdue first.
    const days = r.body.items.map((x: Row) => x.daysOverdue);
    expect(days).toEqual([...days].sort((a: number, b: number) => b - a));
    // The cursor still continues where the page ended (existing clients).
    const next = await bm.get(`/customers?limit=1000&cursor=${encodeURIComponent(r.body.nextCursor)}`);
    expect(next.body.items).toHaveLength(N_A - 1000);
    expect(next.body.nextCursor).toBeNull();
  });

  it('limit above 1000, offset below 0, a fractional or non-numeric offset → 400; default limit unchanged (50)', async () => {
    const bm = await user('01700000002');
    expect((await bm.get('/customers?limit=1001')).status).toBe(400);
    expect((await bm.get('/customers?limit=0')).status).toBe(400);
    expect((await bm.get('/customers?offset=-1')).status).toBe(400);
    expect((await bm.get('/customers?offset=1.5')).status).toBe(400);
    expect((await bm.get('/customers?offset=abc')).status).toBe(400);
    expect((await bm.get('/customers?offset=1000001')).status).toBe(400);
    expect((await bm.get('/customers?cursor=%%%')).status).toBe(400);
    expect((await bm.get('/customers')).body.items).toHaveLength(50);
  });

  for (const sort of SORTS)
    it(`offset with sort=${sort}: pages of 500 equal pages of 1000, no overlap, any page directly`, async () => {
      const bm = await user('01700000002');
      const all = await walk(bm, `sort=${sort}`, 1000);
      expect(all).toHaveLength(N_A);
      expect(new Set(all).size).toBe(N_A);
      expect(await walk(bm, `sort=${sort}`, 500)).toEqual(all);
      // Pages of 100 once (default sort below): 13 requests per walk count against the rate limit.
      // Jump straight to page 8 of 100.
      const p8 = await bm.get(`/customers?sort=${sort}&limit=100&offset=700`);
      expect(p8.body.items.map((x: Row) => x.id)).toEqual(all.slice(700, 800));
      expectConforms('GET', '/customers', 200, p8.body);
    });

  it('pages of 100 through offset equal pages of 1000 (default sort)', async () => {
    const bm = await user('01700000002');
    expect(await walk(bm, '', 100)).toEqual(await walk(bm, '', 1000));
  });

  it('offset with sort=distance (nearest first, capped at the nearest 2000)', async () => {
    const bm = await user('01700000002');
    const q = 'sort=distance&near=22.71,90.37&radiusM=100000';
    const first = await bm.get(`/customers?${q}&limit=1000&offset=0`);
    const second = await bm.get(`/customers?${q}&limit=1000&offset=1000`);
    const ids = [...first.body.items, ...second.body.items].map((x: Row & { distanceM: number }) => x.id);
    expect(ids).toHaveLength(N_A);
    expect(new Set(ids).size).toBe(N_A);
    const d = [...first.body.items, ...second.body.items].map((x: { distanceM: number }) => x.distanceM);
    expect(d).toEqual([...d].sort((a, b) => a - b));
    expect(second.body.nextCursor).toBeNull();
  });

  it('offset wins over cursor; offset past the end is an empty page', async () => {
    const bm = await user('01700000002');
    const p1 = await bm.get('/customers?sort=name&limit=100');
    const viaOffset = await bm.get(
      `/customers?sort=name&limit=100&offset=300&cursor=${encodeURIComponent(p1.body.nextCursor)}`,
    );
    const direct = await bm.get('/customers?sort=name&limit=100&offset=300');
    expect(viaOffset.body.items.map((x: Row) => x.id)).toEqual(direct.body.items.map((x: Row) => x.id));
    expect(viaOffset.body.nextCursor).toBe(direct.body.nextCursor);
    const past = await bm.get('/customers?limit=100&offset=5000&includeTotal=true');
    expect(past.status).toBe(200);
    expect(past.body.items).toEqual([]);
    expect(past.body.nextCursor).toBeNull();
    expect(past.body.total).toBe(N_A);
  });
});

describe('customer list query plan (1.46.0)', () => {
  const SORT_SPECS: Record<string, Record<string, 1 | -1>> = {
    '-daysOverdue': { 'derived.daysOverdue': -1, _id: 1 },
    name: { 'name.en': 1, _id: 1 },
    '-totalOutstanding': { 'derived.totalOutstandingPoisha': -1, _id: 1 },
    nextDueDate: { 'derived.nextDueDate': 1, _id: 1 },
  };
  const stages = (plan: unknown): string[] => {
    const out: string[] = [];
    const visit = (p: unknown) => {
      if (!p || typeof p !== 'object') return;
      const o = p as Record<string, unknown>;
      if (typeof o.stage === 'string') out.push(o.stage);
      for (const k of ['inputStage', 'queryPlan']) visit(o[k]);
      if (Array.isArray(o.inputStages)) o.inputStages.forEach(visit);
    };
    visit(plan);
    return out;
  };

  for (const [name, sort] of Object.entries(SORT_SPECS))
    for (const [who, filter] of <[string, Record<string, unknown>][]>[
      ['branch scope', { $and: [{ branchId: { $in: ['x'] } }] }],
      ['two branches', { $and: [{ branchId: { $in: ['x', 'y'] } }] }],
      ['super admin', { $and: [{}] }],
    ])
      it(`sort ${name} (${who}) uses an index, no in-memory SORT`, async () => {
        const explain = (await CustomerModel.find(filter)
          .select(LIST_PROJECTION)
          .sort(sort)
          .skip(900)
          .limit(1001)
          .explain('queryPlanner')) as unknown;
        const e = explain as { queryPlanner: { winningPlan: unknown } }[] | { queryPlanner: { winningPlan: unknown } };
        const plan = Array.isArray(e) ? e[0]!.queryPlanner.winningPlan : e.queryPlanner.winningPlan;
        const st = stages(plan);
        expect(st).toContain('IXSCAN');
        expect(st).not.toContain('SORT');
        expect(st).not.toContain('COLLSCAN');
      });

  it('the list projection leaves heavy ERP fields out', async () => {
    const doc = (await CustomerModel.findOne({ branchId: s.branchA }).select(LIST_PROJECTION).lean()) as Record<
      string,
      unknown
    > & {
      plans: Record<string, unknown>[];
      derived: { plans: { lines: Record<string, unknown>[] }[] };
    };
    expect(doc.guarantor).toBeUndefined();
    expect(doc.erpRisk).toBeUndefined();
    expect(Object.keys(doc.plans[0]!).sort()).toEqual(['kind', 'outstandingPoisha', 'status']);
    expect(Object.keys(doc.derived.plans[0]!.lines[0]!)).toEqual(['status']);
  });
});
