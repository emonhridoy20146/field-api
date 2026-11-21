import { describe, expect, it } from 'vitest';
import { dateInRange, isDue, promiseFor, verdict } from '../domain/evaluate.js';

describe('promise rules', () => {
  it('date must be today..+60 days', () => {
    expect(dateInRange('2026-11-15', '2026-11-15')).toBe(true);
    expect(dateInRange('2026-11-14', '2026-11-15')).toBe(false);
    expect(dateInRange('2027-01-14', '2026-11-15')).toBe(true);
    expect(dateInRange('2027-01-15', '2026-11-15')).toBe(false);
  });
  it('verdicts', () => {
    expect(verdict(500, 500)).toBe('kept');
    expect(verdict(100, 500)).toBe('partially_kept');
    expect(verdict(0, 500)).toBe('broken');
  });
  it('judged only after promised date + grace', () => {
    expect(isDue('2026-11-15', 1, '2026-11-16')).toBe(false);
    expect(isDue('2026-11-15', 1, '2026-11-17')).toBe(true);
    expect(isDue('2026-11-15', 0, '2026-11-16')).toBe(true);
  });
});

describe('the promise a collection was made against (FR-CASH-008)', () => {
  const p = (id: string, x: Partial<Parameters<typeof promiseFor>[0][number]> = {}) => ({ id, customerId: 'c1', erpPlanId: 'inv1', createdDate: '2026-11-10', promisedDate: '2026-11-15', status: 'open', ...x });
  const coll = { customerId: 'c1', erpPlanId: 'inv1', businessDate: '2026-11-15' };

  it('same customer and invoice, made before the collection, not yet past the date plus grace', () => {
    expect(promiseFor([p('a')], coll, 1)?.id).toBe('a');
    expect(promiseFor([p('a')], { ...coll, businessDate: '2026-11-16' }, 1)?.id).toBe('a'); // within grace
    expect(promiseFor([p('a')], { ...coll, businessDate: '2026-11-17' }, 1)).toBeNull(); // past grace
    expect(promiseFor([p('a')], { ...coll, businessDate: '2026-11-09' }, 1)).toBeNull(); // before the promise
    expect(promiseFor([p('a', { customerId: 'c2' })], coll, 1)).toBeNull();
    expect(promiseFor([p('a', { erpPlanId: 'inv2' })], coll, 1)).toBeNull();
  });

  it('a promise without an invoice covers any invoice; cancelled and superseded ones never count', () => {
    expect(promiseFor([p('a', { erpPlanId: null })], coll, 1)?.id).toBe('a');
    expect(promiseFor([p('a', { status: 'cancelled' }), p('b', { status: 'superseded' })], coll, 1)).toBeNull();
    expect(promiseFor([p('a', { status: 'kept' })], coll, 1)?.id).toBe('a');
  });

  it('several match: the newest promise wins', () => {
    expect(promiseFor([p('old', { createdDate: '2026-11-01' }), p('new', { createdDate: '2026-11-12' })], coll, 1)?.id).toBe('new');
  });
});
