import { describe, expect, it } from 'vitest';
import { paidThisMonthFilter } from '../domain/paid-month.js';

describe('paid this month filter (FR-CUS-019)', () => {
  const erp = { recentPayments: { $elemMatch: { date: { $gte: '2026-11-01', $lte: '2026-11-31' }, reversed: { $ne: true } } } };

  it('yes = an ERP payment dated in the month or a pending field collection of the month', () => {
    expect(paidThisMonthFilter('yes', '2026-11', ['a', 'b'])).toEqual({ $or: [erp, { _id: { $in: ['a', 'b'] } }] });
  });

  it('no = neither', () => {
    expect(paidThisMonthFilter('no', '2026-11', ['a'])).toEqual({ $nor: [erp, { _id: { $in: ['a'] } }] });
  });

  it('without pending collections only the ERP payments decide', () => {
    expect(paidThisMonthFilter('yes', '2026-02', [])).toEqual({ $or: [{ recentPayments: { $elemMatch: { date: { $gte: '2026-02-01', $lte: '2026-02-31' }, reversed: { $ne: true } } } }] });
    expect(paidThisMonthFilter('no', '2026-02', [])).toEqual({ $nor: [{ recentPayments: { $elemMatch: { date: { $gte: '2026-02-01', $lte: '2026-02-31' }, reversed: { $ne: true } } } }] });
  });
});
