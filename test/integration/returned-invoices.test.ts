import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, seedBasics, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { erpPaidBetween, getByErpId } from '../../src/modules/customers/index.js';
import { CustomerModel } from '../../src/modules/customers/models/customer.model.js';
import { setAsideReturnedPlans, showReturnedPlans } from '../../src/modules/customers/service.js';

/**
 * Contract 1.50.0 (FR-CUS-023, ADR-068, owner request 2026-11-26): invoices returned in the ERP are kept apart from
 * the invoices FOS counts; the customer stays. A paid-off invoice (also not collectable) is shown as before.
 * Contract 1.53.0 (FR-CUS-024, ADR-071 amends ADR-068): returned invoices are shown again (`returnedPlans`, marked),
 * never counted; their ERP payments are shown, never counted; list rows carry `returnedInvoiceCount` / `onlyReturned`.
 * The test clock is 2026-11-15 10:00 Dhaka, so every payment below is "this month".
 */
let t: TestApp;
const ids: Record<string, string> = {};

const payment = (id: number, invoiceId: number | null, date: string, amount: string, collector: string) => ({
  id,
  payment_number: `PAY-${date.replace(/-/g, '')}-${id}`,
  customer_id: null,
  sales_invoice_id: invoiceId,
  payment_date: date,
  amount,
  settlement_discount: '0.00',
  payment_method: 'cash',
  payment_method_id: 4,
  payment_method_name: 'Cash-03',
  payment_method_type: 'cash',
  collector_employee_id: 7,
  collector_name: collector,
  reference_no: null,
  is_advance: false,
  source: 'office',
  idempotency_key: null,
  created_at: `${date}T15:10:00+06:00`,
});

const customer = (id: number, name: string, invoices: unknown[], recentPayments: unknown[] = []) => ({
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
  recent_payments: recentPayments,
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

type Plan = { erpPlanId: string; status: string; invoiceNo?: string; returned?: boolean; collectable?: boolean; payments?: { erpPaymentId: string; returned?: boolean }[] };
type Marker = { returnedInvoiceCount: number; onlyReturned: boolean };
type Change = { entity: string; op: string; id: string; data?: { plans: Plan[]; returnedPlanIds: string[]; returnedPlans: Plan[] } & Marker };
const planIds = (plans: Plan[]) => plans.map((p) => p.erpPlanId).sort();
const codes = (r: { body: { items: { erpCustomerId: string }[] } }) => r.body.items.map((x) => x.erpCustomerId).sort();

beforeAll(async () => {
  t = await createTestApp();
  await seedBasics(t);
  t.erp.seedLaravel({
    customers: [
      customer(
        400001,
        'Return Mixed',
        [
          credit(40011, 'S-40011', 'returned', '2000.00', '8000.00'), // returned with money "due": shown apart, never counted
          credit(40012, 'S-40012', 'posted', '5000.00', '0.00'), // paid off: shown as before
          credit(40013, 'S-40013', 'posted', '1000.00', '4000.00'), // open
        ],
        [
          payment(70011, 40011, '2026-11-05', '2000.00', 'Returned Clerk'), // to the returned invoice: shown, not counted
          payment(70013, 40013, '2026-11-10', '1000.00', 'Office Clerk'),
          payment(70099, null, '2026-11-12', '500.00', 'Loose Clerk'), // no invoice: counted as before
        ],
      ),
      customer(400002, 'Only Returned', [credit(40021, 'S-40021', 'returned', '300.00', '2700.00')], [payment(70021, 40021, '2026-11-03', '300.00', 'Returned Clerk')]),
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

  it('customer list keeps the customer, counts only the invoices it counts', async () => {
    const c = await as(t, '01700000001');
    const r = await c.get('/customers?q=Return%20Mixed&includeTotal=true');
    expect(r.status).toBe(200);
    expectConforms('GET', '/customers', 200, r.body);
    expect(codes(r)).toEqual(['400001']);
    expect(r.body.items[0]).toMatchObject({ invoiceCount: { total: 2, open: 1 }, openInvoices: { installment: 0, credit: 1 }, totalOutstandingPoisha: 400000, returnedInvoiceCount: 1, onlyReturned: false });
    expect(r.body.invoiceTotals).toMatchObject({ total: 2, open: 1, creditOpen: 1 });
    // Only returned invoices: the customer is still listed (owner's choice), with no invoices.
    const only = await c.get('/customers?q=Only%20Returned&includeTotal=true');
    expect(codes(only)).toEqual(['400002']);
    expect(only.body.items[0]).toMatchObject({ invoiceCount: { total: 0, open: 0 }, totalOutstandingPoisha: 0, payState: 'paid_off', returnedInvoiceCount: 1, onlyReturned: true });
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
    // 1.53.0: an only-returned customer can still be opened (office users may need it).
    expect(only.status).toBe(200);
    expectConforms('GET', '/customers/{id}', 200, only.body);
    expect(only.body.plans).toEqual([]);
    expect(only.body.returnedPlanIds).toEqual(['40021']);
  });

  it('out of scope is still 404, without a token 401', async () => {
    expect((await (await as(t, '01700000005')).get(`/customers/${ids['400001']}`)).status).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/customers/${ids['400001']}` })).statusCode).toBe(401);
  });

  it('1.53.0: invoice search also finds a returned invoice number, and the row carries the marker; a paid-off one is still found', async () => {
    const c = await as(t, '01700000001');
    expect(codes(await c.get('/customers?q=S-40011'))).toEqual(['400001']);
    const only = await c.get('/customers?q=s40021');
    expectConforms('GET', '/customers', 200, only.body);
    expect(codes(only)).toEqual(['400002']);
    expect(only.body.items[0]).toMatchObject({ returnedInvoiceCount: 1, onlyReturned: true });
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

describe('returned invoices are shown, never counted (FR-CUS-024, contract 1.53.0)', () => {
  it('customer detail shows the returned invoice in returnedPlans with its payments; plans and totals are unchanged', async () => {
    const c = await as(t, '01700000003');
    const d = await c.get(`/customers/${ids['400001']}`);
    expect(d.status).toBe(200);
    expectConforms('GET', '/customers/{id}', 200, d.body);
    expect(planIds(d.body.plans)).toEqual(['40012', '40013']);
    expect(d.body.returnedPlanIds).toEqual(['40011']);
    expect(d.body.returnedPlans).toHaveLength(1);
    const r = d.body.returnedPlans[0] as Plan & { schedule: unknown[] };
    expect(r).toMatchObject({ erpPlanId: '40011', invoiceNo: 'S-40011', status: 'closed', returned: true, collectable: false, invoiceStatus: 'returned', schedule: [] });
    expect(r.payments).toEqual([expect.objectContaining({ erpPaymentId: '70011', erpPlanId: '40011', amountPoisha: 200000, returned: true })]);
    expect(d.body).toMatchObject({ totalOutstandingPoisha: 400000, invoiceCount: { total: 2, open: 1 }, returnedInvoiceCount: 1, onlyReturned: false });
    // The customer's payment list keeps every ERP payment; the returned one is marked, the others are not.
    const pays = new Map((d.body.payments as { erpPaymentId: string; returned?: boolean }[]).map((p) => [p.erpPaymentId, p]));
    expect(pays.get('70011')!.returned).toBe(true);
    expect(pays.get('70013')!.returned).toBeUndefined();
    expect(pays.get('70099')!.returned).toBeUndefined();
    // Shown invoices never carry the returned-only fields.
    for (const p of d.body.plans as Plan[]) expect(p.returned ?? p.collectable ?? p.payments).toBeUndefined();

    const only = await c.get(`/customers/${ids['400002']}`);
    expect(only.status).toBe(200);
    expectConforms('GET', '/customers/{id}', 200, only.body);
    expect(only.body).toMatchObject({ plans: [], returnedPlanIds: ['40021'], returnedInvoiceCount: 1, onlyReturned: true, totalOutstandingPoisha: 0 });
    expect(planIds(only.body.returnedPlans)).toEqual(['40021']);
  });

  it('paid this month (amount, paidBy, filter) leaves out payments to a returned invoice; an untied payment still counts', async () => {
    const c = await as(t, '01700000001');
    const r = await c.get('/customers?q=Return&sort=name');
    expect(r.status).toBe(200);
    const byCode = new Map((r.body.items as { erpCustomerId: string; activity: { paidPoisha: number; lastPaidDate: string | null; paidBy: { name: string; amountPoisha: number }[] } }[]).map((i) => [i.erpCustomerId, i.activity]));
    expect(byCode.get('400001')).toMatchObject({ paidPoisha: 150000, lastPaidDate: '2026-11-12' });
    expect(byCode.get('400001')!.paidBy.map((p) => [p.name, p.amountPoisha])).toEqual([
      ['Loose Clerk', 50000],
      ['Office Clerk', 100000],
    ]);
    expect(byCode.get('400002')).toMatchObject({ paidPoisha: 0, lastPaidDate: null, paidBy: [] });
    expect(codes(await c.get('/customers?q=Return&paidThisMonth=yes'))).toEqual(['400001']);
    expect(codes(await c.get('/customers?q=Return&paidThisMonth=no'))).toEqual(['400002']);
  });

  it('promise evaluation does not count payments to a returned invoice', async () => {
    const id = ids['400001']!;
    expect(await erpPaidBetween(id, null, '2026-11-01', '2026-11-30')).toBe(150000);
    expect(await erpPaidBetween(id, '40013', '2026-11-01', '2026-11-30')).toBe(150000); // own + the untied payment
    expect(await erpPaidBetween(id, '40011', '2026-11-01', '2026-11-30')).toBe(50000); // only the untied payment
    expect(await erpPaidBetween(ids['400002']!, null, '2026-11-01', '2026-11-30')).toBe(0);
  });

  it('timeline shows the returned invoice payment, marked', async () => {
    const c = await as(t, '01700000003');
    const r = await c.get(`/customers/${ids['400001']}/timeline?limit=50`);
    expect(r.status).toBe(200);
    expectConforms('GET', '/customers/{id}/timeline', 200, r.body);
    const items = r.body.items as { kind: string; refId: string; summary: { en: string; bn: string }; data: { returned?: boolean; erpPlanId?: string } }[];
    const ret = items.find((i) => i.kind === 'erp_payment' && i.refId === '70011')!;
    expect(ret.data).toMatchObject({ returned: true, erpPlanId: '40011' });
    expect(ret.summary.en).toContain('returned invoice');
    expect(ret.summary.bn).toContain('ফেরত চালান');
    const normal = items.find((i) => i.kind === 'erp_payment' && i.refId === '70013')!;
    expect(normal.data.returned).toBeUndefined();
    expect(normal.summary.en).not.toContain('returned');
  });

  it('map pins and global search carry the marker', async () => {
    const c = await as(t, '01700000001');
    const m = await c.get('/customers/map?bbox=90.36,22.70,90.38,22.72&zoom=16');
    expect(m.status).toBe(200);
    expectConforms('GET', '/customers/map', 200, m.body);
    const pins = new Map((m.body.pins as ({ id: string } & Marker)[]).map((p) => [p.id, p]));
    expect(pins.get(ids['400001']!)).toMatchObject({ returnedInvoiceCount: 1, onlyReturned: false });
    expect(pins.get(ids['400002']!)).toMatchObject({ returnedInvoiceCount: 1, onlyReturned: true });

    const s = await c.get('/search?q=S-40021&types=customer');
    expect(s.status).toBe(200);
    expectConforms('GET', '/search', 200, s.body);
    expect(s.body).toEqual([expect.objectContaining({ type: 'customer', id: ids['400002'], returnedInvoiceCount: 1, onlyReturned: true })]);
    const n = await c.get('/search?q=Return%20Mixed&types=customer');
    expect(n.body).toEqual([expect.objectContaining({ id: ids['400001'], returnedInvoiceCount: 1, onlyReturned: false })]);
  });

  it('sync bootstrap sends returnedPlans and the marker; returnedPlanIds stays for 1.50 clients', async () => {
    const fs = await as(t, '01700000003');
    const items: Change[] = [];
    let cursor: string | null = null;
    do {
      const r: { status: number; body: { items: Change[]; nextCursor: string | null } } = await fs.get(`/sync/bootstrap?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(r.status).toBe(200);
      expectConforms('GET', '/sync/bootstrap', 200, r.body);
      items.push(...r.body.items);
      cursor = r.body.nextCursor;
    } while (cursor);
    const mixed = items.find((i) => i.entity === 'customer' && i.id === ids['400001'])!.data!;
    expect(planIds(mixed.plans)).toEqual(['40012', '40013']);
    expect(mixed.returnedPlanIds).toEqual(['40011']);
    expect(mixed.returnedPlans.map((p) => [p.erpPlanId, p.returned, p.collectable])).toEqual([['40011', true, false]]);
    expect(mixed).toMatchObject({ returnedInvoiceCount: 1, onlyReturned: false });
    const only = items.find((i) => i.entity === 'customer' && i.id === ids['400002'])!.data!;
    expect(only).toMatchObject({ plans: [], returnedPlanIds: ['40021'], returnedInvoiceCount: 1, onlyReturned: true });
    expect(planIds(only.returnedPlans)).toEqual(['40021']);
  });

  it('migration: payments cached before 1.53.0 get flagged and the customers reach phones on pull; a second run changes nothing', async () => {
    // The shape before 1.53.0: no `returned` flag on the cached payments.
    for (const erpCustomerId of ['400001', '400002']) {
      const doc = (await CustomerModel.findOne({ erpCustomerId }).lean()) as unknown as { recentPayments: Record<string, unknown>[] };
      await CustomerModel.updateOne({ erpCustomerId }, { $set: { recentPayments: doc.recentPayments.map(({ returned: _r, ...p }) => p) } });
    }
    const fs = await as(t, '01700000003');
    let head = '';
    for (let cursor: string | null = null; ; ) {
      const r: { body: { nextCursor: string | null; pullCursor?: string } } = await fs.get(`/sync/bootstrap?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      cursor = r.body.nextCursor;
      if (!cursor) {
        head = r.body.pullCursor!;
        break;
      }
    }
    const versions = async () => Object.fromEntries((await CustomerModel.find({ erpCustomerId: { $in: ['400001', '400002'] } }).lean()).map((d) => [d.erpCustomerId, d.version]));
    const before = await versions();

    expect(await showReturnedPlans()).toBe(2);
    const doc = (await CustomerModel.findOne({ erpCustomerId: '400001' }).lean()) as unknown as { recentPayments: { erpPaymentId: string; returned?: boolean }[] };
    expect(doc.recentPayments.filter((p) => p.returned).map((p) => p.erpPaymentId)).toEqual(['70011']);
    const after = await versions();
    expect(after['400001']).toBeGreaterThan(before['400001']!);

    const pull = await fs.get(`/sync/pull?cursor=${head}&limit=200`);
    expect(pull.status).toBe(200);
    expectConforms('GET', '/sync/pull', 200, pull.body);
    const changes = pull.body.changes as Change[];
    for (const e of ['400001', '400002']) {
      const ch = changes.find((x) => x.entity === 'customer' && x.id === ids[e])!;
      expect(ch.op).toBe('upsert');
      expect(ch.data!.returnedPlans).toHaveLength(1);
    }
    // Paid-this-month filter works on the flag written by the migration.
    const c = await as(t, '01700000001');
    expect(codes(await c.get('/customers?q=Return&paidThisMonth=no'))).toEqual(['400002']);

    // Idempotent: the same flags again; it only re-sends the same customers.
    expect(await showReturnedPlans()).toBe(2);
    const again = (await CustomerModel.findOne({ erpCustomerId: '400001' }).lean()) as unknown as { recentPayments: unknown[] };
    expect(again.recentPayments).toEqual(doc.recentPayments);
  });

  it('out of scope is 404 and without a token 401 on the timeline too', async () => {
    expect((await (await as(t, '01700000005')).get(`/customers/${ids['400002']}/timeline`)).status).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/customers/${ids['400002']}` })).statusCode).toBe(401);
  });
});
