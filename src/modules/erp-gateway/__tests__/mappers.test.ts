import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mapBranch, mapCustomer, mapCustomerPage, mapPaymentError, mapPosted, toPaymentRequest } from '../mappers/laravel-v1.js';

const fx = (n: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../test/fixtures/erp/v1/${n}`, import.meta.url)), 'utf8'));

describe('Laravel v1 mappers (contract fixtures)', () => {
  it('maps branches', () => {
    const b = mapBranch(fx('branches.ok.json').data[0]);
    expect(b).toMatchObject({ erpBranchId: '3', code: 'BRL01', name: { bn: 'বরিশাল সদর', en: 'Barishal Sadar' }, lat: 22.701002, lng: 90.353451, active: true });
  });
  it('maps customers with money as decimal strings to integer poisha', () => {
    const page = mapCustomerPage(fx('customers.ok.json'));
    const c = page.items[0]!;
    expect(c.erpCustomerId).toBe('100245');
    expect(c.plans[0]!.outstandingPoisha).toBe(850000);
    expect(c.plans[0]!.endDate).toBe('2026-10-10');
    expect(c.plans[0]!.schedule[5]).toEqual({ seq: 6, dueDate: '2026-10-10', amountPoisha: 966600, paidPoisha: 116600 });
    expect(c.recentPayments[0]).toMatchObject({ erpPaymentId: '9921', source: 'office', amountPoisha: 966600 });
    expect(page.nextCursor).toBeNull();
  });
  it('handles nulls: missing coords, missing Bangla name, null end_date, null per-line paid (E-05, E-07)', () => {
    const items = fx('customers.ok.json').data.map(mapCustomer);
    expect(items[2].lat).toBeNull();
    expect(items[2].name.bn).toBe('Shahidul Islam');
    expect(items[2].plans[0].status).toBe('completed');
    expect(items[3].plans[1].endDate).toBeNull();
    expect(items[3].plans[1].schedule[0].paidPoisha).toBeNull();
    expect(items[3].plans[0].outstandingPoisha).toBe(1);
  });
  it('accepts money as numbers and string ids', () => {
    const c = mapCustomer({ id: 'X1', branch_id: 3, name: 'A', plans: [{ id: 'P1', outstanding: 100.5, paid_total: 0, principal: 1, down_payment: 0, total_payable: 1, schedule: [] }] });
    expect(c.plans[0]!.outstandingPoisha).toBe(10050);
  });
  it('builds the payment request with Dhaka offset and decimal amount', () => {
    const body = toPaymentRequest({
      idempotencyKey: 'k', erpCustomerId: '100245', erpPlanId: '55021', erpBranchId: '3', amountPoisha: 500000, method: 'bank_transfer', transactionRef: 'T1',
      collectedAt: new Date('2026-11-15T05:12:44Z'), employeeId: null, fieldReceiptNo: 'BRL01-FS014-261115-0007', physicalReceiptNo: null, note: null, fieldCollectionId: 'abc', geo: { lat: 22.7101, lng: 90.3705, accuracyM: 12.4 },
    });
    expect(body).toMatchObject({ customer_id: 100245, plan_id: 55021, amount: '5000.00', method: 'bank', collected_at: '2026-11-15T11:12:44+06:00', source: 'field_app' });
    expect(body.geo).toEqual({ latitude: '22.710100', longitude: '90.370500', accuracy_m: 12 });
  });
  it('maps posted responses and §5.2 errors', () => {
    expect(mapPosted(fx('payment.posted.json'))).toMatchObject({ kind: 'posted', erpPaymentId: '10233', receiptNo: 'R-78010', planOutstandingAfterPoisha: 350000, replay: false });
    expect(mapPaymentError(422, fx('payment.error.plan-settled.json'), null)).toMatchObject({ kind: 'business_error', code: 'PLAN_SETTLED' });
    expect(mapPaymentError(422, fx('payment.error.validation.json'), null)).toMatchObject({ kind: 'business_error', code: 'ERP_VALIDATION' });
    expect(mapPaymentError(422, { error: { code: 'IDEMPOTENCY_MISMATCH' } }, null)).toMatchObject({ kind: 'fatal', code: 'IDEMPOTENCY_MISMATCH' });
    expect(mapPaymentError(423, {}, null)).toMatchObject({ kind: 'business_error', code: 'PERIOD_LOCKED' });
    expect(mapPaymentError(401, {}, null)).toMatchObject({ kind: 'fatal', code: 'AUTH' });
    expect(mapPaymentError(429, {}, '12')).toEqual({ kind: 'transient', error: 'rate limited', retryAfterSec: 12 });
    expect(mapPaymentError(503, {}, null).kind).toBe('transient');
    expect(mapPaymentError(409, { error: { code: 'CONCURRENT_REQUEST' } }, null)).toMatchObject({ kind: 'transient', retryAfterSec: 5 });
    expect(mapPaymentError(404, { error: { code: 'CUSTOMER_NOT_FOUND' } }, null)).toMatchObject({ code: 'PLAN_NOT_FOUND' });
  });
});
