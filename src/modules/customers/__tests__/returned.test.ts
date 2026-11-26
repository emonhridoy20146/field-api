import { describe, expect, it } from 'vitest';
import { isReturnedPlan, mergeReturned, splitReturned } from '../domain/returned.js';

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
