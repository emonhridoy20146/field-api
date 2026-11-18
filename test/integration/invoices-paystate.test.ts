import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createTestApp, seedBasics, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { getByErpId } from '../../src/modules/customers/index.js';
import { CustomerModel } from '../../src/modules/customers/models/customer.model.js';
import { recomputeAllDerived } from '../../src/modules/customers/service.js';

/**
 * Contract 1.14.0: pin colours by payment state (FR-CUS-012, ADR-035), the invoice filters and the
 * invoice viewer fields (FR-CUS-013). Today is 2026-11-15 (Dhaka).
 */
let t: TestApp;
const ids: Record<string, string> = {};

const line = (no: number, due: string, amount: string, paid: string, payments: unknown[] = []) => ({
  id: Number(`9${no}`),
  installment_no: no,
  due_date: due,
  due_amount: amount,
  paid_amount: paid,
  late_fee_amount: '0.00',
  remaining_amount: (Number(amount) - Number(paid)).toFixed(2),
  status: 'pending',
  written_off: '0.00',
  payments,
});

const customer = (id: number, name: string, lat: string, invoices: unknown[]) => ({
  id,
  customer_code: `BRL01-${id}`,
  name,
  phone: `0171${String(id).padStart(7, '0')}`,
  phone_numbers: [],
  branch_id: 3,
  branch_source: 'customer',
  address: 'Test Road',
  latitude: lat,
  longitude: '90.371000',
  is_active: true,
  outstanding_balance: '0.00',
  updated_at: '2026-11-14T10:00:00+06:00',
  changed_at: '2026-11-14T10:00:00+06:00',
  invoices,
  recent_payments: [],
  removed_payments: [],
});

const money = { discount_total: '0.00', tax_total: '0.00', written_off: '0.00', settlement_discount: '0.00', refunded: '0.00', guarantor: null };

beforeAll(async () => {
  t = await createTestApp();
  await seedBasics(t);
  t.erp.seedLaravel({
    customers: [
      // Pay-later sale: one due date at the end of the year, part paid → on track, open credit invoice.
      customer(300001, 'Credit Buyer', '22.712000', [
        {
          ...money,
          id: 77001,
          invoice_number: 'INV-77001',
          invoice_date: '2026-10-01',
          branch_id: 3,
          sale_type: 'credit',
          status: 'posted',
          payment_status: 'partial',
          collectable: true,
          subtotal: '12500.00',
          discount_total: '500.00',
          grand_total: '12000.00',
          amount_paid: '2000.00',
          amount_due: '10000.00',
          credit_due_date: '2026-12-31',
          items: [{ line_id: 1, product_id: 9, name: 'LED TV', model_number: '32-inch', qty: 1, unit_price: '12500.00', discount_amount: '0.00', service_charge: '0.00', line_total: '12500.00', serials: [] }],
          installment_plan: null,
        },
      ]),
      // Monthly plan, the November installment was missed → yellow.
      customer(300002, 'One Miss', '22.713000', [
        {
          ...money,
          id: 77002,
          invoice_number: 'INV-77002',
          invoice_date: '2026-09-05',
          branch_id: 3,
          sale_type: 'installment',
          status: 'active',
          payment_status: 'partial',
          collectable: true,
          subtotal: '9000.00',
          grand_total: '9000.00',
          amount_paid: '3000.00',
          amount_due: '6000.00',
          credit_due_date: null,
          items: [{ line_id: 2, product_id: 10, name: 'Ceiling Fan', model_number: null, qty: 2, unit_price: '4500.00', discount_amount: '0.00', service_charge: '0.00', line_total: '9000.00', serials: [] }],
          installment_plan: {
            id: 88002,
            status: 'active',
            total_amount: '9000.00',
            down_payment: '0.00',
            financed_amount: '9000.00',
            remaining_amount: '6000.00',
            frequency: 'monthly',
            custom_days: null,
            installment_count: 3,
            penalty_enabled: true,
            penalty_rate: '0.0200',
            schedules: [
              line(1, '2026-10-05', '3000.00', '3000.00', [{ payment_id: 501, payment_number: 'PAY-20261008-00501', payment_date: '2026-10-08', amount: '3000.00' }]),
              line(2, '2026-11-05', '3000.00', '0.00'),
              line(3, '2026-12-05', '3000.00', '0.00'),
            ],
          },
        },
      ]),
    ],
  });
  await deltaSync();
  for (const e of ['100245', '100246', '100247', '100248', '200301', '300001', '300002']) ids[e] = (await getByErpId(e))!.id;
});
afterAll(async () => t.close());

const codes = (r: { body: { items: { erpCustomerId: string }[] } }) => r.body.items.map((x) => x.erpCustomerId).sort();

describe('pin colour by payment state (FR-CUS-012)', () => {
  it('every customer gets the colour the owner asked for', async () => {
    const c = await as(t, '01700000001');
    const res = await c.get('/customers?limit=50');
    expect(res.status).toBe(200);
    expectConforms('GET', '/customers', 200, res.body);
    const by = Object.fromEntries(res.body.items.map((x: { erpCustomerId: string; payState: string; missedCount: number }) => [x.erpCustomerId, [x.payState, x.missedCount]]));
    expect(by).toEqual({
      '100245': ['bad', 1], // plan term ended 2026-10-10 with money left
      '100246': ['due_today', 0],
      '100247': ['paid_off', 0],
      '100248': ['bad', 1], // 1 poisha left after the last date (no tolerance, FR-TAG-001)
      '200301': ['missed_many', 3],
      '300001': ['on_track', 0],
      '300002': ['missed_one', 1],
    });
    expect(res.body.items.find((x: { erpCustomerId: string }) => x.erpCustomerId === '300001').openInvoices).toEqual({ installment: 0, credit: 1 });
  });

  it('payState filters combine with OR and narrow other filters; unknown values are a 400', async () => {
    const c = await as(t, '01700000001');
    expect(codes(await c.get('/customers?payState=missed_one,missed_many'))).toEqual(['200301', '300002']);
    expect(codes(await c.get('/customers?payState=bad'))).toEqual(['100245', '100248']);
    expect(codes(await c.get('/customers?payState=on_track,paid_off'))).toEqual(['100247', '300001']);
    expect(codes(await c.get(`/customers?payState=bad&branchId=${(await c.get('/branches')).body.find((b: { code: string }) => b.code === 'PTK01').id}`))).toEqual([]);
    expect((await c.get('/customers?payState=purple')).status).toBe(400);
  });

  it('a watch tag alone does not make a pin red', async () => {
    await CustomerModel.updateOne({ erpCustomerId: '300001' }, { $set: { 'fos.tag': { state: 'tagged', severity: 'watch' } } });
    const c = await as(t, '01700000001');
    expect(codes(await c.get('/customers?payState=bad'))).toEqual(['100245', '100248']);
    await CustomerModel.updateOne({ erpCustomerId: '300001' }, { $set: { 'fos.tag': { state: 'tagged', severity: 'bad' } } });
    expect(codes(await c.get('/customers?payState=bad'))).toEqual(['100245', '100248', '300001']);
    await CustomerModel.updateOne({ erpCustomerId: '300001' }, { $set: { 'fos.tag': null } });
  });

  it('map pins carry the colour; clusters carry the worst colour and a count per colour', async () => {
    const c = await as(t, '01700000001');
    const pins = await c.get('/customers/map?bbox=90.30,22.65,90.42,22.75&zoom=15');
    expectConforms('GET', '/customers/map', 200, pins.body);
    const p = pins.body.pins.find((x: { id: string }) => x.id === ids['300002']);
    expect(p).toMatchObject({ payState: 'missed_one', missedCount: 1 });
    const yellow = await c.get('/customers/map?bbox=90.30,22.65,90.42,22.75&zoom=15&payState=missed_one');
    expect(yellow.body.pins.map((x: { id: string }) => x.id)).toEqual([ids['300002']]);
    const clusters = await c.get('/customers/map?bbox=90.30,22.65,90.42,22.75&zoom=9');
    expectConforms('GET', '/customers/map', 200, clusters.body);
    expect(clusters.body.pins).toEqual([]);
    const all = clusters.body.clusters as { worstPayState: string; payStates: Record<string, number>; count: number }[];
    expect(all.some((g) => g.worstPayState === 'bad')).toBe(true);
    expect(all.reduce((n, g) => n + Object.values(g.payStates).reduce((a, b) => a + b, 0), 0)).toBe(all.reduce((n, g) => n + g.count, 0));
  });

  it('customers cached before 1.14.0 still get a colour, and the recompute job fills missedCount', async () => {
    await CustomerModel.updateOne({ erpCustomerId: '300002' }, { $unset: { 'derived.missedCount': 1 } });
    const c = await as(t, '01700000001');
    const item = (await c.get('/customers?q=One%20Miss')).body.items[0];
    expect(item).toMatchObject({ payState: 'missed_one', missedCount: 1 });
    expect(codes(await c.get('/customers?payState=missed_one'))).toEqual([]);
    await recomputeAllDerived();
    expect(codes(await c.get('/customers?payState=missed_one'))).toEqual(['300002']);
  });
});

describe('invoice filters and viewer (FR-CUS-013)', () => {
  it('invoiceKind keeps customers with an open invoice of that kind', async () => {
    const c = await as(t, '01700000001');
    expect(codes(await c.get('/customers?invoiceKind=credit'))).toEqual(['300001']);
    const inst = codes(await c.get('/customers?invoiceKind=installment'));
    expect(inst).toContain('300002');
    expect(inst).not.toContain('300001');
    expect(inst).not.toContain('100247'); // paid off: no open invoice
    expect(codes(await c.get('/customers?invoiceKind=credit&payState=bad'))).toEqual([]);
    expect((await c.get('/customers?invoiceKind=cash')).status).toBe(400);
  });

  it('installment lines show which payment paid them, when, and how late', async () => {
    const c = await as(t, '01700000001');
    const res = await c.get(`/customers/${ids['100245']}`);
    expectConforms('GET', '/customers/{id}', 200, res.body);
    const plan = res.body.plans[0];
    expect(plan).toMatchObject({ payState: 'bad', missedCount: 1, daysOverdue: 36, subtotalPoisha: 6_800_000, discountPoisha: 0, financedPoisha: 5_800_000, penalty: { enabled: false, rate: '0.0000' }, invoiceStatus: 'active', paymentStatus: 'partial' });
    expect(plan.branchId).toBeTruthy();
    expect(plan.items[0]).toMatchObject({ unitPricePoisha: 6_800_000, lineTotalPoisha: 6_800_000 });
    const [l1, l2, , , , l6] = plan.schedule;
    expect(l1).toMatchObject({ paidOn: '2026-05-10', daysLate: 0, missed: false, payments: [{ erpPaymentId: '9100', receiptNo: 'PAY-20260510-09100', date: '2026-05-10', amountPoisha: 966_700 }] });
    expect(l2).toMatchObject({ paidOn: '2026-06-12', daysLate: 2 });
    expect(l6).toMatchObject({ status: 'overdue', missed: true, daysLate: 36, outstandingPoisha: 850_000 });
    expect(l6.paidOn).toBeUndefined();
  });

  it('a credit invoice shows its one due date, discount and what is left', async () => {
    const c = await as(t, '01700000001');
    const res = await c.get(`/customers/${ids['300001']}`);
    expectConforms('GET', '/customers/{id}', 200, res.body);
    const plan = res.body.plans[0];
    expect(plan).toMatchObject({ kind: 'credit', creditDueDate: '2026-12-31', finalDueDate: '2026-12-31', payState: 'on_track', nextDueDate: '2026-12-31', nextDuePoisha: 1_000_000, subtotalPoisha: 1_250_000, discountPoisha: 50_000, totalPayablePoisha: 1_200_000, outstandingPoisha: 1_000_000 });
    expect(plan.penalty).toBeUndefined();
  });

  it('a field collection shows up on the installment line it paid after the next sync', async () => {
    const fs = await as(t, '01700000001');
    const before = (await fs.get(`/customers/${ids['300002']}`)).body.plans[0].schedule[1];
    expect(before.payments).toEqual([]);
    t.erp.officePayment('300002', '77002', 300_000);
    await deltaSync();
    const after = (await fs.get(`/customers/${ids['300002']}`)).body.plans[0];
    expect(after.schedule[1]).toMatchObject({ status: 'paid', paidOn: '2026-11-15', daysLate: 10, missed: false });
    expect(after.schedule[1].payments).toHaveLength(1);
    expect(after.payState).toBe('on_track');
  });
});
