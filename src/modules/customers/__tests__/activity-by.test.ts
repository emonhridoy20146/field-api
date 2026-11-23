import { describe, expect, it } from 'vitest';
import { paidByOfMonth, type MonthCollectionRef } from '../domain/activity-by.js';

const col = (over: Partial<MonthCollectionRef> = {}): MonthCollectionRef => ({
  idempotencyKey: 'k1',
  userId: 'u1',
  name: 'Rakib Hasan',
  amountPoisha: 1000,
  businessDate: '2026-11-10',
  pending: false,
  ...over,
});

describe('paidByOfMonth (FR-CUS-021)', () => {
  it('staff collector by key, else ERP referrer, else posted name, else unknown; newest first', () => {
    const out = paidByOfMonth(
      '2026-11',
      [
        { date: '2026-11-10', amountPoisha: 1000, idempotencyKey: 'k1', collectorName: 'ERP Name' },
        { date: '2026-11-12', amountPoisha: 2000, collectorName: ' Office Clerk ' },
        { date: '2026-11-08', amountPoisha: 3000, collectorName: '', referenceName: 'By Name' },
        { date: '2026-11-01', amountPoisha: 4000 },
      ],
      [col()],
    );
    expect(out).toEqual([
      { name: 'Office Clerk', source: 'erp_referrer', amountPoisha: 2000, lastDate: '2026-11-12', pending: false },
      { name: 'Rakib Hasan', source: 'staff', userId: 'u1', amountPoisha: 1000, lastDate: '2026-11-10', pending: false },
      { name: 'By Name', source: 'collector_name', amountPoisha: 3000, lastDate: '2026-11-08', pending: false },
      { name: '', source: 'unknown', amountPoisha: 4000, lastDate: '2026-11-01', pending: false },
    ]);
  });

  it('leaves out removed payments, other months and bad rows; groups one person; keeps pending money apart', () => {
    const out = paidByOfMonth(
      '2026-11',
      [
        { date: '2026-11-03', amountPoisha: 500, collectorName: 'Clerk' },
        { date: '2026-11-05', amountPoisha: 700, collectorName: 'Clerk' },
        { date: '2026-11-06', amountPoisha: 900, collectorName: 'Clerk', reversed: true },
        { date: '2026-10-31', amountPoisha: 900, collectorName: 'Clerk' },
        { date: null, amountPoisha: 900 },
        { date: '2026-11-07', amountPoisha: 'x', collectorName: 'Clerk' },
      ],
      [
        col({ idempotencyKey: 'p1', pending: true, amountPoisha: 300, businessDate: '2026-11-09' }),
        col({ idempotencyKey: 'p2', pending: true, amountPoisha: 200, businessDate: '2026-11-04' }),
        col({ idempotencyKey: 'p3', pending: true, amountPoisha: 999, businessDate: '2026-10-30' }),
        col({ idempotencyKey: 'p4', pending: false, amountPoisha: 999, businessDate: '2026-11-09' }),
      ],
    );
    expect(out).toEqual([
      { name: 'Rakib Hasan', source: 'staff', userId: 'u1', amountPoisha: 500, lastDate: '2026-11-09', pending: true },
      { name: 'Clerk', source: 'erp_referrer', amountPoisha: 1200, lastDate: '2026-11-07', pending: false },
    ]);
  });

  it('nothing this month → empty', () => {
    expect(paidByOfMonth('2026-11', [], [])).toEqual([]);
  });
});
