import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, seedBasics, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { getByErpId } from '../../src/modules/customers/index.js';
import { CustomerModel } from '../../src/modules/customers/models/customer.model.js';
import { setAsideReturnedPlans } from '../../src/modules/customers/service.js';

/**
 * Contract 1.50.0 (FR-CUS-023, ADR-068, owner request 2026-11-26): invoices returned in the ERP are not shown in
 * the admin panel or the staff app; the customer stays. A paid-off invoice (also not collectable) is shown as before.
 */
let t: TestApp;
const ids: Record<string, string> = {};

const customer = (id: number, name: string, invoices: unknown[]) => ({
  id,
  customer_code: `BRL01-${id}`,
  name,
  phone: `0171${String(id).padStart(7, '0')}`,
  phone_numbers: [],
  branch_id: 3,
  branch_source: 'customer',
  address: 'Test Road',
  latitude: '22.714000',
  longitude: '90.371000',
  is_active: true,
  outstanding_balance: '0.00',
  updated_at: '2026-11-14T10:00:00+06:00',
  changed_at: '2026-11-14T10:00:00+06:00',
  invoices,
  recent_payments: [],
  removed_payments: [],
});

/** A pay-later (credit) invoice: one due date, no schedule rows to fake. */
const credit = (id: number, no: string, status: string, paid: string, due: string) => ({
  id,
  invoice_number: no,
  invoice_date: '2026-10-01',
  branch_id: 3,
  sale_type: 'credit',
  status,
  payment_status: Number(due) > 0 ? 'partial' : 'paid',
  collectable: status !== 'returned' && Number(due) > 0,
  subtotal: (Number(paid) + Number(due)).toFixed(2),
  discount_total: '0.00',
  tax_total: '0.00',
  grand_total: (Number(paid) + Number(due)).toFixed(2),
  amount_paid: paid,
  amount_due: due,
  written_off: '0.00',
  settlement_discount: '0.00',
  refunded: status === 'returned' ? paid : '0.00',
  credit_due_date: '2026-12-31',
  guarantor: null,
  items: [{ line_id: id, product_id: 9, name: 'LED TV', model_number: null, qty: 1, unit_price: '1000.00', discount_amount: '0.00', service_charge: '0.00', line_total: '1000.00', serials: [] }],
  installment_plan: null,
});

type Plan = { erpPlanId: string; status: string; invoiceNo?: string };
type Change = { entity: string; op: string; id: string; data?: { plans: Plan[]; returnedPlanIds: string[] } };
const planIds = (plans: Plan[]) => plans.map((p) => p.erpPlanId).sort();
const codes = (r: { body: { items: { erpCustomerId: string }[] } }) => r.body.items.map((x) => x.erpCustomerId).sort();

beforeAll(async () => {
  t = await createTestApp();
  await seedBasics(t);
  t.erp.seedLaravel({
    customers: [
      customer(400001, 'Return Mixed', [
        credit(40011, 'S-40011', 'returned', '2000.00', '8000.00'), // returned with money "due": hidden
        credit(40012, 'S-40012', 'posted', '5000.00', '0.00'), // paid off: shown as before
        credit(40013, 'S-40013', 'posted', '1000.00', '4000.00'), // open
      ]),
      customer(400002, 'Only Returned', [credit(40021, 'S-40021', 'returned', '0.00', '3000.00')]),
    ],
  });
  await deltaSync();
  for (const e of ['400001', '400002']) ids[e] = (await getByErpId(e))!.id;
});
afterAll(async () => t.close());

describe('returned invoices are hidden (FR-CUS-023)', () => {
  it('stores the return apart from the shown plans, with status closed kept', async () => {
    const doc = (await CustomerModel.findOne({ erpCustomerId: '400001' }).lean()) as unknown as { plans: Plan[]; returnedPlans: (Plan & { returned: boolean; invoiceStatus: string })[] };
    expect(planIds(doc.plans)).toEqual(['40012', '40013']);
    expect(doc.returnedPlans).toHaveLength(1);
    expect(doc.returnedPlans[0]).toMatchObject({ erpPlanId: '40011', status: 'closed', returned: true, invoiceStatus: 'returned' });
  });

  it('customer list keeps the customer, counts only the invoices it shows', async () => {
    const c = await as(t, '01700000001');
    const r = await c.get('/customers?q=Return%20Mixed&includeTotal=true');
    expect(r.status).toBe(200);
    expectConforms('GET', '/customers', 200, r.body);
    expect(codes(r)).toEqual(['400001']);
    expect(r.body.items[0]).toMatchObject({ invoiceCount: { total: 2, open: 1 }, openInvoices: { installment: 0, credit: 1 }, totalOutstandingPoisha: 400000 });
    expect(r.body.invoiceTotals).toMatchObject({ total: 2, open: 1, creditOpen: 1 });
    // Only returned invoices: the customer is still listed (owner's choice), with no invoices.
    const only = await c.get('/customers?q=Only%20Returned&includeTotal=true');
    expect(codes(only)).toEqual(['400002']);
    expect(only.body.items[0]).toMatchObject({ invoiceCount: { total: 0, open: 0 }, totalOutstandingPoisha: 0 });
    expect(only.body.invoiceTotals).toMatchObject({ total: 0, open: 0 });
    expect(codes(await c.get('/customers?invoiceKind=credit&q=Only%20Returned'))).toEqual([]);
  });

  it('customer detail lists no returned invoice and names it in returnedPlanIds; a paid-off invoice is shown as before', async () => {
    const c = await as(t, '01700000003');
    const d = await c.get(`/customers/${ids['400001']}`);
    expect(d.status).toBe(200);
    expectConforms('GET', '/customers/{id}', 200, d.body);
    expect(planIds(d.body.plans)).toEqual(['40012', '40013']);
    expect(d.body.plans.find((p: Plan) => p.erpPlanId === '40012')).toMatchObject({ status: 'completed', invoiceNo: 'S-40012' });
    expect(d.body.returnedPlanIds).toEqual(['40011']);
    const only = await c.get(`/customers/${ids['400002']}`);
    expect(only.status).toBe(200);
    expectConforms('GET', '/customers/{id}', 200, only.body);
    expect(only.body.plans).toEqual([]);
    expect(only.body.returnedPlanIds).toEqual(['40021']);
  });

  it('out of scope is still 404, without a token 401', async () => {
    expect((await (await as(t, '01700000005')).get(`/customers/${ids['400001']}`)).status).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/customers/${ids['400001']}` })).statusCode).toBe(401);
  });

  it('invoice search does not find a returned invoice; a paid-off one is still found', async () => {
    const c = await as(t, '01700000001');
    expect(codes(await c.get('/customers?q=S-40011'))).toEqual([]);
    expect(codes(await c.get('/customers?q=S-40021'))).toEqual([]);
    expect(codes(await c.get('/customers?q=S40012'))).toEqual(['400001']);
    expect(codes(await c.get('/customers?q=s-40013'))).toEqual(['400001']);
  });

  it('sync bootstrap sends the customers without the returned invoices', async () => {
    const fs = await as(t, '01700000003');
    const items: Change[] = [];
    let cursor: string | null = null;
    do {
      const r: { status: number; body: { items: Change[]; nextCursor: string | null; pullCursor?: string } } = await fs.get(`/sync/bootstrap?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(r.status).toBe(200);
      expectConforms('GET', '/sync/bootstrap', 200, r.body);
      items.push(...r.body.items);
      cursor = r.body.nextCursor;
    } while (cursor);
    const mixed = items.find((i) => i.entity === 'customer' && i.id === ids['400001'])!;
    expect(planIds(mixed.data!.plans)).toEqual(['40012', '40013']);
    expect(mixed.data!.returnedPlanIds).toEqual(['40011']);
    const only = items.find((i) => i.entity === 'customer' && i.id === ids['400002'])!;
    expect(only.data!.plans).toEqual([]);
    expect(only.data!.returnedPlanIds).toEqual(['40021']);
  });

  it('migration: a returned invoice cached before 1.50.0 is set aside and reaches phones on pull; a second run does nothing', async () => {
    // The shape before 1.50.0: the returned invoice inside `plans`, only told apart by invoiceStatus.
    const doc = (await CustomerModel.findOne({ erpCustomerId: '400001' }).lean()) as unknown as { plans: Plan[]; returnedPlans: Record<string, unknown>[] };
    const legacy = doc.returnedPlans.map(({ returned: _r, ...p }) => p);
    await CustomerModel.updateOne({ erpCustomerId: '400001' }, { $set: { plans: [...doc.plans, ...legacy] }, $unset: { returnedPlans: 1 } });
    const fs = await as(t, '01700000003');
    expect(planIds((await fs.get(`/customers/${ids['400001']}`)).body.plans)).toEqual(['40011', '40012', '40013']);

    let head = '';
    for (let cursor: string | null = null; ; ) {
      const r: { status: number; body: { items: Change[]; nextCursor: string | null; pullCursor?: string } } = await fs.get(`/sync/bootstrap?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      cursor = r.body.nextCursor;
      if (!cursor) {
        head = r.body.pullCursor!;
        break;
      }
    }

    expect(await setAsideReturnedPlans()).toBe(1);
    const d = await fs.get(`/customers/${ids['400001']}`);
    expect(planIds(d.body.plans)).toEqual(['40012', '40013']);
    expect(d.body.returnedPlanIds).toEqual(['40011']);
    expect(d.body.totalOutstandingPoisha).toBe(400000);

    const pull = await fs.get(`/sync/pull?cursor=${head}&limit=200`);
    expect(pull.status).toBe(200);
    expectConforms('GET', '/sync/pull', 200, pull.body);
    const ch = (pull.body.changes as Change[]).find((x) => x.entity === 'customer' && x.id === ids['400001'])!;
    expect(ch.op).toBe('upsert');
    expect(planIds(ch.data!.plans)).toEqual(['40012', '40013']);
    expect(ch.data!.returnedPlanIds).toEqual(['40011']);

    expect(await setAsideReturnedPlans()).toBe(0);
  });

  it('a later ERP read (refresh from the ERP) keeps the returned invoice hidden', async () => {
    const c = await as(t, '01700000001');
    const before = (await CustomerModel.findOne({ erpCustomerId: '400002' }).lean())!.version;
    const r = await c.post(`/customers/${ids['400002']}/refresh`, {});
    expect(r.status).toBe(200);
    expect((await CustomerModel.findOne({ erpCustomerId: '400002' }).lean())!.version).toBeGreaterThan(before);
    const d = await c.get(`/customers/${ids['400002']}`);
    expect(d.body.plans).toEqual([]);
    expect(d.body.returnedPlanIds).toEqual(['40021']);
  });
});
