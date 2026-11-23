import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { ErpSyncStateModel } from '../../src/modules/erp-gateway/models/sync-state.model.js';
import { CustomerModel } from '../../src/modules/customers/models/customer.model.js';

// "Sync from ERP" button (contract 1.17.0).
let t: TestApp;
let s: Seeded;

beforeAll(async () => {
  t = await createTestApp();
  s = await seedBasics(t);
});
afterAll(async () => t.close());

describe('POST /system/erp-sync (1.17.0)', () => {
  it('pulls the customers from the ERP now; a second run finds nothing new', async () => {
    expect(await CustomerModel.countDocuments()).toBe(0);
    const sa = await as(t, '01700000001');
    const r = await sa.post('/system/erp-sync', {});
    expect(r.status).toBe(200);
    expectConforms('POST', '/system/erp-sync', 200, r.body);
    expect(r.body.partial).toBe(false);
    expect(r.body.customers).toBeGreaterThan(0);
    expect(await CustomerModel.countDocuments()).toBe(r.body.customers);
    // the ERP status in the header now has a fresh "last sync"
    const st = await sa.get('/system/erp-status');
    expect(st.body.lagSec).toBeLessThan(30);
    // the lock is released, so the next press works
    const next = await sa.post('/system/erp-sync', {});
    expect(next.status).toBe(200);
    expect(next.body.customers).toBeLessThanOrEqual(r.body.customers);
  });

  it('a branch manager may press it; field staff and viewers may not (403); no token is 401', async () => {
    expect((await (await as(t, '01700000002')).post('/system/erp-sync', {})).status).toBe(200);
    expect((await (await as(t, '01700000003')).post('/system/erp-sync', {})).status).toBe(403);
    expect((await (await as(t, '01700000006')).post('/system/erp-sync', {})).status).toBe(403);
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/system/erp-sync' })).statusCode).toBe(401);
  });

  it('a run holding the lock makes the button wait (429 SYNC_RUNNING), an expired lock does not', async () => {
    const sa = await as(t, '01700000001');
    await ErpSyncStateModel.updateOne({ _id: 'manual-sync' }, { $set: { lockedUntil: new Date(t.ctx.clock.now().getTime() + 60_000) } }, { upsert: true });
    const busy = await sa.post('/system/erp-sync', {});
    expect(busy.status).toBe(429);
    expect(busy.body.details.reason).toBe('SYNC_RUNNING');
    await ErpSyncStateModel.updateOne({ _id: 'manual-sync' }, { $set: { lockedUntil: new Date(t.ctx.clock.now().getTime() - 1000) } });
    expect((await sa.post('/system/erp-sync', {})).status).toBe(200);
  });

  it('503 ERP_UNAVAILABLE when the ERP cannot be reached, and the lock is released', async () => {
    const sa = await as(t, '01700000001');
    const orig = t.erp.listBranches.bind(t.erp);
    t.erp.listBranches = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const down = await sa.post('/system/erp-sync', {});
    expect(down.status).toBe(503);
    expect(down.body.code).toBe('ERP_UNAVAILABLE');
    t.erp.listBranches = orig;
    expect((await sa.post('/system/erp-sync', {})).status).toBe(200);
  });
});

describe('deltaSync with a time budget (1.17.0)', () => {
  it('stops at the budget, remembers the page, and the next run finishes and moves the watermark', async () => {
    await ErpSyncStateModel.deleteMany({ _id: { $regex: '^customers:branch:' } });
    await CustomerModel.deleteMany({});
    // A budget of 0 ms stops after the first page of the first branch (page size 100 > fixture size, so use a tiny page via the mock).
    const origList = t.erp.listCustomers.bind(t.erp);
    let pages = 0;
    t.erp.listCustomers = async (q) => {
      pages += 1;
      const page = await origList({ ...q, pageSize: 1 });
      return page;
    };
    const first = await deltaSync({ budgetMs: 0 });
    expect(first.partial).toBe(true);
    const branchStates = await ErpSyncStateModel.find({ _id: { $regex: '^customers:branch:' } }).lean();
    expect(branchStates.some((x) => x.resume)).toBe(true);
    expect(branchStates.every((x) => !x.cursor)).toBe(true); // watermark not moved yet

    // finish: no budget, continues from the saved page
    let guard = 0;
    let last = await deltaSync();
    while (last.partial && guard++ < 20) last = await deltaSync();
    expect(last.partial).toBe(false);
    const done = await ErpSyncStateModel.find({ _id: { $regex: '^customers:branch:' } }).lean();
    expect(done.every((x) => x.resume === null || x.resume === undefined)).toBe(true);
    expect(done.some((x) => x.cursor)).toBe(true);
    expect(await CustomerModel.countDocuments()).toBeGreaterThan(0);
    expect(pages).toBeGreaterThan(1);
    t.erp.listCustomers = origList;
    void s;
  });
});

describe('deltaSync keeps going where the old one got stuck (1.44.0)', () => {
  const reset = async () => {
    await ErpSyncStateModel.deleteMany({ _id: { $regex: '^customers:branch:' } });
    await CustomerModel.deleteMany({});
  };
  const erpTotal = async () => {
    let n = 0;
    for (const b of await t.erp.listBranches()) n += (await t.erp.listCustomers({ erpBranchId: b.erpBranchId, pageSize: 1000 })).items.length;
    return n;
  };

  it('a run stopped by the host mid-branch continues from the last page instead of starting the branch again', async () => {
    await reset();
    const total = await erpTotal();
    expect(total).toBeGreaterThan(2);
    const origList = t.erp.listCustomers.bind(t.erp);
    const cursors: (string | null)[] = [];
    let calls = 0;
    // page size 1; the host "stops the function" (throws) on the 3rd page of the run
    t.erp.listCustomers = async (q) => {
      calls += 1;
      if (calls === 3) throw new Error('function stopped at 60 s');
      cursors.push(q.cursor ?? null);
      return origList({ ...q, pageSize: 1 });
    };
    const first = await deltaSync();
    expect(first.failedBranches).toBeGreaterThan(0);
    const stuck = await ErpSyncStateModel.find({ resume: { $ne: null } }).lean();
    expect(stuck.length).toBeGreaterThan(0);
    const saved = stuck[0]!.resume as { cursor: string | null };
    expect(saved.cursor).not.toBeNull(); // progress of the pages before the stop is kept
    cursors.length = 0;
    const second = await deltaSync();
    expect(second.failedBranches).toBe(0);
    expect(cursors).toContain(saved.cursor);
    expect(await CustomerModel.countDocuments()).toBe(total);
    t.erp.listCustomers = origList;
  });

  it('the budget is checked per customer: with no time left each run still adds customers and none is done twice', async () => {
    await reset();
    const total = await erpTotal();
    const seen: string[] = [];
    let listening = true;
    t.ctx.bus.on('erp.customer.synced', async (p) => void (listening && seen.push((p.customer as { erpCustomerId: string }).erpCustomerId)));
    let runs = 0;
    let last = await deltaSync({ budgetMs: 0 });
    runs += 1;
    expect(last.partial).toBe(true);
    expect(last.customers).toBe(1);
    const mid = await ErpSyncStateModel.findOne({ resume: { $ne: null } }).lean();
    expect((mid!.resume as { done: string[] }).done).toHaveLength(1);
    while (last.partial && runs < 50) {
      last = await deltaSync({ budgetMs: 0 });
      runs += 1;
    }
    expect(last.partial).toBe(false);
    expect(await CustomerModel.countDocuments()).toBe(total);
    expect(new Set(seen).size).toBe(seen.length); // nobody published twice
    expect(seen.length).toBe(total);
    listening = false;
  });

  it('a row the ERP sends that cannot be read is skipped and counted; the branch still finishes and moves its watermark', async () => {
    await reset();
    const total = await erpTotal();
    const origList = t.erp.listCustomers.bind(t.erp);
    t.erp.listCustomers = async (q) => {
      const page = await origList(q);
      return q.cursor ? page : { ...page, skipped: [{ erpCustomerId: '999001', error: 'name: Expected string, received null' }] };
    };
    const sa = await as(t, '01700000001');
    const r = await sa.post('/system/erp-sync', {});
    expect(r.status).toBe(200);
    expectConforms('POST', '/system/erp-sync', 200, r.body);
    const branches = (await t.erp.listBranches()).length;
    expect(r.body.skipped).toBe(branches);
    expect(r.body.failedBranches).toBe(0);
    expect(r.body.partial).toBe(false);
    expect(await CustomerModel.countDocuments()).toBe(total);
    const st = await ErpSyncStateModel.find({ _id: { $regex: '^customers:branch:' } }).lean();
    expect(st.every((x) => !!x.cursor)).toBe(true);
    expect((st[0]!.lastSkipped as { erpCustomerId: string }[])[0]!.erpCustomerId).toBe('999001');
    t.erp.listCustomers = origList;
  });

  it('a page that answers with the same cursor again ends the branch instead of looping', async () => {
    await reset();
    const origList = t.erp.listCustomers.bind(t.erp);
    let calls = 0;
    t.erp.listCustomers = async (q) => {
      calls += 1;
      const page = await origList({ ...q, pageSize: 1 });
      return { ...page, nextCursor: q.cursor ?? 'same' };
    };
    const r = await deltaSync();
    expect(r.partial).toBe(false);
    expect(calls).toBeLessThanOrEqual((await t.erp.listBranches()).length * 2);
    t.erp.listCustomers = origList;
  });
});

describe('erp.customerScope (1.44.0)', () => {
  it('receivables leaves out a cash-only customer; all (the default) pulls it on the next run, starting every branch over', async () => {
    const { setSystem } = await import('../../src/modules/settings/index.js');
    await ErpSyncStateModel.deleteMany({ _id: { $regex: '^customers:branch:' } });
    await CustomerModel.deleteMany({});
    const any = (await t.erp.listCustomers({ pageSize: 1 })).items[0]!;
    t.erp.upsertCustomer({ ...structuredClone(any), erpCustomerId: '777001', code: 'CUS777001', plans: [], recentPayments: [], updatedAt: '2026-01-01T00:00:00Z' });
    await setSystem('erp.customerScope', 'receivables');
    const def = await deltaSync();
    expect(def.failedBranches).toBe(0);
    expect(await CustomerModel.countDocuments({ erpCustomerId: '777001' })).toBe(0);
    const before = await CustomerModel.countDocuments();
    // a delta run with the old watermark would not see it (unchanged since January): the scope change starts over
    await setSystem('erp.customerScope', 'all');
    const all = await deltaSync();
    expect(all.partial).toBe(false);
    expect(await CustomerModel.countDocuments({ erpCustomerId: '777001' })).toBe(1);
    expect(await CustomerModel.countDocuments()).toBe(before + 1);
    const st = await ErpSyncStateModel.find({ _id: { $regex: '^customers:branch:' } }).lean();
    expect(st.every((x) => (x as { scope?: string }).scope === 'all')).toBe(true);
    t.erp.removeCustomer('777001');
  });

  it('a customer with only a paid cash sale appears with nothing due; the cash invoice is listed but never open', async () => {
    const any = (await t.erp.listCustomers({ pageSize: 1 })).items[0]!;
    const cashPlan = { ...structuredClone(any.plans[0]!), erpPlanId: '990001', kind: 'cash' as const, status: 'completed' as const, schedule: [], outstandingPoisha: 0, paidPoisha: 1200000, installmentCount: 0, startDate: null, endDate: null };
    t.erp.upsertCustomer({ ...structuredClone(any), erpCustomerId: '777002', code: 'CUS777002', plans: [cashPlan], recentPayments: [], updatedAt: t.ctx.clock.now().toISOString() });
    await deltaSync();
    const id = (await CustomerModel.findOne({ erpCustomerId: '777002' }).lean())!._id.toHexString();
    const sa = await as(t, '01700000001');
    const det = await sa.get(`/customers/${id}`);
    expect(det.status).toBe(200);
    expectConforms('GET', '/customers/{id}', 200, det.body);
    expect(det.body.totalOutstandingPoisha).toBe(0);
    expect(det.body.overduePoisha).toBe(0);
    expect(det.body.daysOverdue).toBe(0);
    expect(det.body.invoiceCount).toEqual({ total: 1, open: 0 });
    expect(det.body.openInvoices).toEqual({ installment: 0, credit: 0 });
    expect(det.body.plans[0].kind).toBe('cash');
    const overdue = await sa.get('/customers?filter=overdue&limit=200');
    expect((overdue.body.items as { id: string }[]).map((r) => r.id)).not.toContain(id);
    t.erp.removeCustomer('777002');
  });
});

