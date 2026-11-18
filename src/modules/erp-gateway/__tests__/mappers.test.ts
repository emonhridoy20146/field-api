import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  mapBranch,
  mapCustomer,
  mapCustomerPage,
  mapEmployee,
  mapPaymentError,
  mapPosted,
  mapRemovedPayment,
  normalizePhones,
  toPaymentRequest,
} from '../mappers/laravel-v1.js';

const fx = (n: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../test/fixtures/erp/v1/${n}`, import.meta.url)), 'utf8'));

/** A minimal ERP customer row; tests override what they need. */
const customer = (over: Record<string, unknown> = {}) => ({
  id: 1,
  customer_code: 'CUS-1',
  name: 'Test Buyer',
  phone: '01711000001',
  phone_numbers: [],
  branch_id: 3,
  is_active: true,
  invoices: [],
  recent_payments: [],
  removed_payments: [],
  ...over,
});

const invoice = (over: Record<string, unknown> = {}) => ({
  id: 900,
  invoice_number: 'INV-00900',
  invoice_date: '2026-06-01',
  branch_id: 3,
  sale_type: 'installment',
  status: 'active',
  collectable: true,
  grand_total: '3000.00',
  amount_paid: '1000.00',
  amount_due: '2000.00',
  written_off: '0.00',
  credit_due_date: null,
  items: [{ name: 'Fan', model_number: 'F-1', qty: 2, line_total: '3000.00', serials: [] }],
  installment_plan: {
    id: 77,
    status: 'active',
    total_amount: '3000.00',
    down_payment: '1000.00',
    financed_amount: '2000.00',
    frequency: 'weekly',
    installment_count: 3,
    schedules: [
      {
        id: 1,
        installment_no: 1,
        due_date: '2026-07-01',
        due_amount: '0.00',
        paid_amount: '0.00',
        late_fee_amount: '0.00',
        status: 'pending',
      },
      {
        id: 2,
        installment_no: 2,
        due_date: '2026-08-01',
        due_amount: '1500.00',
        paid_amount: '0.00',
        late_fee_amount: '50.00',
        status: 'pending',
      },
      {
        id: 3,
        installment_no: 3,
        due_date: '2026-09-01',
        due_amount: '500.00',
        paid_amount: '0.00',
        late_fee_amount: '0.00',
        status: 'pending',
      },
    ],
  },
  ...over,
});

describe('ERP field API v1 mappers (contract fixtures)', () => {
  it('maps branches; the ERP has no Bangla name, district or coordinates', () => {
    const b = mapBranch(fx('branches.ok.json').data[0]);
    expect(b).toMatchObject({
      erpBranchId: '3',
      code: 'BRL01',
      name: { bn: 'Barishal Sadar', en: 'Barishal Sadar' },
      district: '',
      lat: null,
      lng: null,
      active: true,
      kind: 'branch',
    });
    expect(mapBranch({ id: 14, code: 'Warehouse SmartPhone', name: 'WH', type: 'warehouse' }).kind).toBe('warehouse');
  });

  it('maps employees (collector ids)', () => {
    expect(mapEmployee(fx('employees.ok.json').data[0])).toEqual({
      erpEmployeeId: '7',
      code: 'EMP-00007',
      name: 'Rakib Hasan',
      phone: '01700000003',
      erpBranchIds: ['3'],
      active: true,
    });
    expect(mapEmployee(fx('employees.ok.json').data[4]).active).toBe(false);
  });

  it('maps a customer page: invoice = plan, decimal strings to integer poisha', () => {
    const page = mapCustomerPage(fx('customers.ok.json'));
    const c = page.items[0]!;
    expect(c.erpCustomerId).toBe('100245');
    expect(c.directions).toBe('Blue gate next to the mosque');
    expect(c.risk).toMatchObject({ grade: 'C', level: 'Medium', overdueCount: 1 });
    expect(c.guarantor).toEqual({ name: 'Abdul Malek', phone: '01911000000' });
    const p = c.plans[0]!;
    expect(p).toMatchObject({
      erpPlanId: '55021',
      kind: 'installment',
      invoiceNo: 'INV-55021',
      erpInstallmentPlanId: '855021',
      product: 'Walton Fridge WFC-3D8',
      outstandingPoisha: 850000,
      status: 'active',
      endDate: '2026-10-10',
      frequency: 'monthly',
    });
    expect(p.schedule[5]).toEqual({
      seq: 6,
      dueDate: '2026-10-10',
      amountPoisha: 966600,
      paidPoisha: 116600,
      lateFeePoisha: 0,
      rolled: false,
      // 1.14.0: the ERP's installment_payment_allocations and write-offs for this line
      payments: [{ erpPaymentId: '9733', receiptNo: 'PAY-20261020-09733', date: '2026-10-20', amountPoisha: 116600 }],
      writtenOffPoisha: 0,
    });
    expect(p).toMatchObject({
      subtotalPoisha: 6800000,
      discountPoisha: 0,
      taxPoisha: 0,
      settlementDiscountPoisha: 0,
      refundedPoisha: 0,
      financedPoisha: 5800000,
      invoiceStatus: 'active',
      paymentStatus: 'partial',
      creditDueDate: null,
      penaltyEnabled: false,
      penaltyRate: '0.0000',
    });
    expect(p.items![0]).toMatchObject({ unitPricePoisha: 6800000, discountPoisha: 0, serviceChargePoisha: 0, lineTotalPoisha: 6800000 });
    expect(c.recentPayments[0]).toMatchObject({
      erpPaymentId: '9921',
      erpPlanId: '55021',
      source: 'office',
      amountPoisha: 966600,
      receiptNo: 'PAY-20260912-09921',
      methodLabel: 'Cash-03',
      collectorName: 'Rakib Hasan',
      reversed: false,
    });
    expect(page.nextCursor).toBeNull();
    expect(page.serverTime).toBe('2026-11-15T07:00:00+06:00');
  });

  it('handles nulls: missing coords, no Bangla name, completed invoice, unknown per-line paid (E-05, E-07)', () => {
    const items = fx('customers.ok.json').data.map(mapCustomer);
    expect(items[2].lat).toBeNull();
    expect(items[2].name).toEqual({ en: 'Shahidul Islam', bn: 'Shahidul Islam' });
    expect(items[2].branchSource).toBe('last_invoice');
    expect(items[2].plans[0].status).toBe('completed');
    expect(items[3].plans[1].endDate).toBe('2027-03-20');
    expect(items[3].plans[1].schedule[0].paidPoisha).toBeNull();
    expect(items[3].plans[0].outstandingPoisha).toBe(1);
    expect(items[4].phones).toEqual(['01812999888']); // "01812-999888" in the ERP
  });

  it('installment lines: amount = due + late fee, zero lines are rolled, items and frequency kept', () => {
    const p = mapCustomer(customer({ invoices: [invoice()] })).plans[0]!;
    expect(p.schedule.map((l) => [l.amountPoisha, l.lateFeePoisha, l.rolled])).toEqual([
      [0, 0, true],
      [155000, 5000, false],
      [50000, 0, false],
    ]);
    expect(p).toMatchObject({
      product: 'Fan F-1 ×2',
      frequency: 'weekly',
      downPaymentPoisha: 100000,
      principalPoisha: 200000,
      installmentCount: 3,
      startDate: '2026-07-01',
      endDate: '2026-09-01',
    });
    expect(p.items).toEqual([{ name: 'Fan', model: 'F-1', qty: 2, serials: [], lineTotalPoisha: 300000 }]);
  });

  it('an ERP without the 1.14.0 fields still maps: line payments and invoice money stay absent', () => {
    const p = mapCustomer(customer({ invoices: [invoice()] })).plans[0]!;
    expect(p.schedule[0]).not.toHaveProperty('payments');
    expect(p.schedule[0]).not.toHaveProperty('writtenOffPoisha');
    expect(p).not.toHaveProperty('subtotalPoisha');
    expect(p).not.toHaveProperty('settlementDiscountPoisha');
    expect(p.items![0]).not.toHaveProperty('unitPricePoisha');
  });

  it('credit invoice becomes one line on credit_due_date; write-offs (inside amount_paid) count as settled once', () => {
    const p = mapCustomer(
      customer({
        invoices: [
          invoice({
            sale_type: 'credit',
            status: 'posted',
            installment_plan: null,
            credit_due_date: '2026-12-05',
            grand_total: '5000.00',
            // the ERP adds the 500 write-off to amount_paid: 1000 cash + 500 written off
            amount_paid: '1500.00',
            amount_due: '3500.00',
            written_off: '500.00',
          }),
        ],
      }),
    ).plans[0]!;
    expect(p).toMatchObject({
      kind: 'credit',
      status: 'active',
      outstandingPoisha: 350000,
      writtenOffPoisha: 50000,
      endDate: '2026-12-05',
      installmentCount: 1,
      erpInstallmentPlanId: null,
      frequency: null,
    });
    expect(p.schedule).toEqual([
      { seq: 1, dueDate: '2026-12-05', amountPoisha: 500000, paidPoisha: 150000, lateFeePoisha: 0, rolled: false },
    ]);
  });

  it('returned and cancelled invoices are not collectable even with a due', () => {
    const c = mapCustomer(
      customer({
        invoices: [
          invoice({ id: 1, status: 'returned', collectable: false }),
          invoice({ id: 2, status: 'cancelled', collectable: false }),
          invoice({ id: 3, amount_due: '0.00', collectable: false }),
        ],
      }),
    );
    expect(c.plans.map((p) => p.status)).toEqual(['closed', 'cancelled', 'completed']);
  });

  it('guarantor: newest open plan first, else the default guarantor; never more than name/phone at customer level', () => {
    const withPlan = mapCustomer(
      customer({
        invoices: [invoice({ guarantor: { name: 'G One', phones: ['+8801511000003'], address: 'X' } })],
        default_guarantor: { name: 'G Default', phones: ['01611000004'] },
      }),
    );
    expect(withPlan.guarantor).toEqual({ name: 'G One', phone: '01511000003' });
    expect(withPlan.plans[0]!.guarantor).toEqual({
      name: 'G One',
      phone: '01511000003',
      phones: ['01511000003'],
      address: 'X',
    });
    expect(
      mapCustomer(customer({ default_guarantor: { name: 'G Default', phones: ['01611000004'] } })).guarantor,
    ).toEqual({ name: 'G Default', phone: '01611000004' });
  });

  it('removed payments come back as reversed, dated from the API, the payment number or the removal', () => {
    const c = mapCustomer(
      customer({
        removed_payments: [
          {
            id: 5,
            payment_number: 'PAY-20261020-00007',
            payment_date: null,
            sales_invoice_id: 900,
            amount: '500.00',
            removed_at: '2026-10-22T10:00:00+06:00',
            idempotency_key: 'k1',
          },
        ],
      }),
    );
    expect(c.recentPayments[0]).toMatchObject({
      erpPaymentId: '5',
      erpPlanId: '900',
      date: '2026-10-20',
      amountPoisha: 50000,
      reversed: true,
      reversedAt: '2026-10-22T10:00:00+06:00',
      source: 'field',
      idempotencyKey: 'k1',
    });
    expect(
      mapRemovedPayment({
        id: 6,
        payment_number: null,
        payment_date: '2026-11-01',
        sales_invoice_id: 1,
        amount: '1.00',
        removed_at: null,
      }).date,
    ).toBe('2026-11-01');
    expect(
      mapRemovedPayment({
        id: 7,
        payment_number: null,
        sales_invoice_id: 1,
        amount: '1.00',
        removed_at: '2026-11-01T20:00:00Z',
      }).date,
    ).toBe('2026-11-02');
  });

  it('normalizes the messy phone fields the ERP holds (findings §2.2)', () => {
    expect(normalizePhones(['01711111111, 01822222222'])).toEqual(['01711111111', '01822222222']);
    expect(normalizePhones(['01711111111 / 01822222222', '01711111111'])).toEqual(['01711111111', '01822222222']);
    expect(normalizePhones(['+8801711111111'])).toEqual(['01711111111']);
    expect(normalizePhones(['1711111111'])).toEqual(['01711111111']);
    expect(normalizePhones(['01711-111111'])).toEqual(['01711111111']);
    expect(normalizePhones(['01711111111, 22222222'])).toEqual(['01711111111', '01722222222']);
    expect(normalizePhones(['(01711111111)'])).toEqual(['01711111111']);
    expect(normalizePhones(['abba 01711111111'])).toEqual(['01711111111']);
    expect(normalizePhones(['0171111111'])).toEqual(['0171111111']); // unusable: raw text kept for staff
    expect(normalizePhones(['', null, 'no number'])).toEqual([]);
  });

  it('accepts money as numbers and string ids; an empty branch id leaves the customer unplaced', () => {
    const c = mapCustomer(
      customer({ id: 'X1', branch_id: null, invoices: [invoice({ id: 'P1', amount_due: 100.5, amount_paid: 0 })] }),
    );
    expect(c.plans[0]!.outstandingPoisha).toBe(10050);
    expect(c.erpBranchId).toBe('');
    expect(c.status).toBe('active');
    expect(mapCustomer(customer({ is_active: false })).status).toBe('inactive');
  });

  it('builds the payment request: invoice id, method type, provider, collector, Dhaka offset', () => {
    const body = toPaymentRequest({
      idempotencyKey: 'k',
      erpCustomerId: '100245',
      erpPlanId: '55021',
      erpBranchId: '3',
      amountPoisha: 500000,
      method: 'bkash',
      transactionRef: 'BK12345678',
      collectedAt: new Date('2026-11-15T05:12:44Z'),
      employeeId: '7',
      fieldReceiptNo: 'BRL01-FS014-261115-0007',
      physicalReceiptNo: 'B-12',
      note: 'paid at shop',
      fieldCollectionId: 'abc',
      geo: { lat: 22.7101, lng: 90.3705, accuracyM: 12.4 },
    });
    expect(body).toEqual({
      sales_invoice_id: 55021,
      customer_id: 100245,
      amount: '5000.00',
      collected_at: '2026-11-15T11:12:44+06:00',
      method_type: 'mobile_banking',
      mobile_provider: 'bkash',
      collector_employee_id: 7,
      transaction_ref: 'BK12345678',
      field_receipt_no: 'BRL01-FS014-261115-0007',
      field_collection_id: 'abc',
      note: 'Book receipt B-12 · paid at shop',
    });
    expect(
      toPaymentRequest({
        idempotencyKey: 'k',
        erpCustomerId: '1',
        erpPlanId: '2',
        erpBranchId: '3',
        amountPoisha: 1,
        method: 'bank_transfer',
        transactionRef: null,
        collectedAt: new Date(),
        employeeId: null,
        fieldReceiptNo: 'r',
        physicalReceiptNo: null,
        note: null,
        fieldCollectionId: 'c',
        geo: null,
      }),
    ).toMatchObject({ method_type: 'bank', mobile_provider: null, collector_employee_id: null, note: null });
  });

  it('maps posted responses and error codes (spec §6)', () => {
    expect(mapPosted(fx('payment.posted.json'))).toMatchObject({
      kind: 'posted',
      erpPaymentId: '10233',
      receiptNo: 'PAY-20261115-00031',
      planOutstandingAfterPoisha: 350000,
      customerOutstandingAfterPoisha: 350000,
      replay: false,
    });
    expect(mapPaymentError(422, fx('payment.error.plan-settled.json'), null)).toMatchObject({
      kind: 'business_error',
      code: 'PLAN_SETTLED',
    });
    expect(mapPaymentError(422, fx('payment.error.validation.json'), null)).toMatchObject({
      kind: 'business_error',
      code: 'ERP_VALIDATION',
    });
    expect(mapPaymentError(422, fx('payment.error.same-day.json'), null)).toMatchObject({
      kind: 'business_error',
      code: 'DUPLICATE_SAME_DAY',
      details: { payment_date: '2026-11-15' },
    });
    for (const code of ['PLAN_CLOSED', 'METHOD_NOT_AVAILABLE', 'COLLECTOR_NOT_LINKED'] as const)
      expect(mapPaymentError(422, { error: { code } }, null)).toMatchObject({ kind: 'business_error', code });
    expect(mapPaymentError(422, { error: { code: 'ERP_REJECTED' } }, null)).toMatchObject({ code: 'ERP_VALIDATION' });
    expect(mapPaymentError(422, { error: { code: 'IDEMPOTENCY_MISMATCH' } }, null)).toMatchObject({
      kind: 'fatal',
      code: 'IDEMPOTENCY_MISMATCH',
    });
    expect(mapPaymentError(423, {}, null)).toMatchObject({ kind: 'business_error', code: 'PERIOD_LOCKED' });
    expect(mapPaymentError(401, {}, null)).toMatchObject({ kind: 'fatal', code: 'AUTH' });
    expect(mapPaymentError(403, { error: { code: 'FORBIDDEN' } }, null)).toMatchObject({ kind: 'fatal', code: 'AUTH' });
    expect(mapPaymentError(429, {}, '12')).toEqual({ kind: 'transient', error: 'rate limited', retryAfterSec: 12 });
    expect(mapPaymentError(503, {}, null).kind).toBe('transient');
    expect(mapPaymentError(409, { error: { code: 'CONCURRENT_REQUEST' } }, null)).toMatchObject({
      kind: 'transient',
      retryAfterSec: 5,
    });
    expect(mapPaymentError(404, { error: { code: 'CUSTOMER_NOT_FOUND' } }, null)).toMatchObject({
      code: 'PLAN_NOT_FOUND',
    });
  });
});
