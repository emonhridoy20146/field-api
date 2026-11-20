import { describe, expect, it } from 'vitest';
import { MAX_EXTRA_PHONES, mergePhones, normalizeMobile, planAdd, type ExtraPhone } from '../domain/phones.js';

const extra = (number: string, over: Partial<ExtraPhone> = {}): ExtraPhone => ({ number, addedBy: 'u1', addedByName: 'Test Staff', addedAt: '2026-11-21T04:00:00.000Z', ...over });

describe('customer phones (FR-CUS-016)', () => {
  it('normalizes Bangladeshi mobile numbers typed in the usual ways', () => {
    expect(normalizeMobile('01711000001')).toBe('01711000001');
    expect(normalizeMobile(' 017-1100 0001 ')).toBe('01711000001');
    expect(normalizeMobile('+8801711000001')).toBe('01711000001');
    expect(normalizeMobile('8801711000001')).toBe('01711000001');
    expect(normalizeMobile('1711000001')).toBe('01711000001');
    expect(normalizeMobile('০১৭১১০০০০০১')).toBe('01711000001');
  });

  it('refuses text, land lines and wrong lengths', () => {
    for (const v of ['', 'abc', '01211000001', '0171100000', '017110000011', '01711000001 wife', '02-9876543']) expect(normalizeMobile(v)).toBeNull();
  });

  it('lists ERP numbers first, then the added ones, and never shows a number twice', () => {
    const list = mergePhones(['01711000001', '01911000002', '01711000001'], [extra('01911000002'), extra('01511000003', { label: 'wife' })]);
    expect(list.map((p) => [p.number, p.source, p.primary])).toEqual([
      ['01711000001', 'erp', true],
      ['01911000002', 'erp', false],
      ['01511000003', 'field', false],
    ]);
    expect(list[2]).toMatchObject({ label: 'wife', addedBy: { id: 'u1', name: 'Test Staff' }, addedAt: '2026-11-21T04:00:00.000Z' });
    expect(mergePhones(null, undefined)).toEqual([]);
    // No ERP number at all: nothing is "primary", the added one is still listed.
    expect(mergePhones([], [extra('01511000003')])[0]).toMatchObject({ source: 'field', primary: false });
  });

  it('adds several at once, skips the ones already there, and adds nothing when one is invalid', () => {
    const plan = planAdd(['01711000001'], [extra('01511000003')], [
      { number: '+8801711000001' },
      { number: '01511000003' },
      { number: '01811000004', label: ' shop ' },
      { number: '01811000004' },
      { number: '01311000005' },
    ]);
    expect(plan.add).toEqual([
      { number: '01811000004', label: 'shop' },
      { number: '01311000005', label: null },
    ]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(['duplicate', 'duplicate', 'duplicate']);
    expect(planAdd([], [], [{ number: '01811000004' }, { number: 'call the shop' }]).invalid).toEqual([{ index: 1, value: 'call the shop' }]);
  });

  it('keeps at most five added numbers per customer', () => {
    const four = ['01811000001', '01811000002', '01811000003', '01811000004'].map((n) => extra(n));
    const plan = planAdd([], four, [{ number: '01911000001' }, { number: '01911000002' }]);
    expect(MAX_EXTRA_PHONES).toBe(5);
    expect(plan.add.map((a) => a.number)).toEqual(['01911000001']);
    expect(plan.skipped).toEqual([{ number: '01911000002', reason: 'limit' }]);
  });
});
