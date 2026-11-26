import { describe, expect, it } from 'vitest';
import { isReturnedPayment, isReturnedPlan, markReturnedPayments, mergeReturned, returnedIdSet, returnedMarker, splitReturned } from '../domain/returned.js';
import { deriveCustomer } from '../domain/status.js';

describe('returned invoices (FR-CUS-023)', () => {
  it('returned = mapper flag, or the stored ERP invoice status (plans cached before 1.50.0)', () => {
    expect(isReturnedPlan({ erpPlanId: '1', returned: true })).toBe(true);
    expect(isReturnedPlan({ erpPlanId: '1', invoiceStatus: 'returned' })).toBe(true);
    expect(isReturnedPlan({ erpPlanId: '1', invoiceStatus: ' Returned ' })).toBe(true);
    expect(isReturnedPlan({ erpPlanId: '1', invoiceStatus: 'posted' })).toBe(false);
    expect(isReturnedPlan({ erpPlanId: '1', invoiceStatus: null })).toBe(false);
    expect(isReturnedPlan({ erpPlanId: '1', returned: false, invoiceStatus: 'cancelled' })).toBe(false);
    // Cached before 1.14.0: nothing tells a return apart, so it is shown until the next ERP read.
    expect(isReturnedPlan({ erpPlanId: '1' })).toBe(false);
  });

  it('split keeps order and marks every set-aside plan returned', () => {
    const plans = [
      { erpPlanId: 'a', status: 'active' },
      { erpPlanId: 'b', status: 'closed', invoiceStatus: 'returned' },
      { erpPlanId: 'c', status: 'completed' },
      { erpPlanId: 'd', status: 'closed', returned: true as const },
    ];
    const r = splitReturned(plans);
    expect(r.visible.map((p) => p.erpPlanId)).toEqual(['a', 'c']);
    expect(r.returned.map((p) => [p.erpPlanId, p.returned, p.status])).toEqual([
      ['b', true, 'closed'],
      ['d', true, 'closed'],
    ]);
    expect(splitReturned([])).toEqual({ visible: [], returned: [] });
  });

  it('merge is by erpPlanId, newest wins, so the migration can run twice', () => {
    const old = [{ erpPlanId: 'a', invoiceStatus: 'returned', n: 1 }];
    const found = [
      { erpPlanId: 'a', invoiceStatus: 'returned', n: 2 },
      { erpPlanId: 'b', invoiceStatus: 'returned', n: 1 },
    ];
    expect(mergeReturned(old, found)).toEqual([found[0], found[1]]);
    expect(mergeReturned(mergeReturned(old, found), found)).toEqual([found[0], found[1]]);
  });

});

describe('returned invoices are shown, never counted (FR-CUS-024, 1.53.0)', () => {
  const ids = returnedIdSet([{ erpPlanId: 'r1' }, { erpPlanId: 2 }]);

  it('a payment is returned when its invoice is returned or it was stored flagged; no invoice = not returned', () => {
    expect([...ids]).toEqual(['r1', '2']);
    expect(isReturnedPayment({ erpPlanId: 'r1' }, ids)).toBe(true);
    expect(isReturnedPayment({ erpPlanId: '2' }, ids)).toBe(true);
    expect(isReturnedPayment({ erpPlanId: 'a' }, ids)).toBe(false);
    expect(isReturnedPayment({ erpPlanId: 'a', returned: true }, ids)).toBe(true);
    // Cannot be tied to an invoice: counted as before 1.53.0.
    expect(isReturnedPayment({ erpPlanId: null }, ids)).toBe(false);
    expect(isReturnedPayment({ erpPlanId: '' }, ids)).toBe(false);
    expect(isReturnedPayment({}, ids)).toBe(false);
    expect(returnedIdSet(undefined).size).toBe(0);
  });

  it('marking is recomputed from scratch, keeps order and every other field', () => {
    const pays = [
      { erpPaymentId: 'p1', erpPlanId: 'r1', amountPoisha: 100 },
      { erpPaymentId: 'p2', erpPlanId: 'a', amountPoisha: 200, returned: true }, // invoice no longer returned
      { erpPaymentId: 'p3', erpPlanId: null, amountPoisha: 300 },
    ];
    const out = markReturnedPayments(pays, ids);
    expect(out).toEqual([
      { erpPaymentId: 'p1', erpPlanId: 'r1', amountPoisha: 100, returned: true },
      { erpPaymentId: 'p2', erpPlanId: 'a', amountPoisha: 200 },
      { erpPaymentId: 'p3', erpPlanId: null, amountPoisha: 300 },
    ]);
    expect(markReturnedPayments(out, ids)).toEqual(out);
    expect(markReturnedPayments(out, new Set())).toEqual(pays.map(({ returned: _r, ...p }) => p));
  });

  it('onlyReturned = has invoices and all of them returned; none at all is not onlyReturned', () => {
    expect(returnedMarker(1, 0)).toEqual({ returnedInvoiceCount: 1, onlyReturned: true });
    expect(returnedMarker(2, 1)).toEqual({ returnedInvoiceCount: 2, onlyReturned: false });
    expect(returnedMarker(0, 0)).toEqual({ returnedInvoiceCount: 0, onlyReturned: false });
    expect(returnedMarker(0, 3)).toEqual({ returnedInvoiceCount: 0, onlyReturned: false });
  });

  it('customer totals come from the shown plans only: a returned invoice with money "due" adds nothing', () => {
    const line = (seq: number, dueDate: string, amountPoisha: number) => ({ seq, dueDate, amountPoisha, paidPoisha: 0 });
    const open = { erpPlanId: 'a', status: 'active', outstandingPoisha: 5000, endDate: null, schedule: [line(1, '2026-11-01', 5000)] };
    const ret = { erpPlanId: 'r1', status: 'closed', returned: true as const, outstandingPoisha: 9000, endDate: null, schedule: [line(1, '2026-10-01', 9000)] };
    const { visible } = splitReturned([open, ret]);
    const d = deriveCustomer(visible, '2026-11-15');
    expect(d.totalOutstandingPoisha).toBe(5000);
    expect(d.overdueAmountPoisha).toBe(5000);
    expect(d.missedCount).toBe(1);
    expect(d.plans.map((p) => p.erpPlanId)).toEqual(['a']);
  });
});

