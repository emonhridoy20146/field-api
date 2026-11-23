import { describe, expect, it } from 'vitest';
import { datesOf, linkTo, monthStart, previousMonth, rate, resolveRange, topBy } from '../domain/dashboard.js';

describe('dashboard range (FR-DSH-002)', () => {
  const today = '2026-11-15';

  it('defaults to the month of `date` up to `date`', () => {
    expect(resolveRange({}, today, today)).toEqual({ from: '2026-11-01', to: '2026-11-15', days: 15 });
    expect(resolveRange({}, '2026-10-20', today)).toEqual({ from: '2026-10-01', to: '2026-10-20', days: 20 });
    expect(resolveRange({ to: '2026-09-05' }, today, today)).toEqual({ from: '2026-09-01', to: '2026-09-05', days: 5 });
    expect(resolveRange({ from: '2026-11-10' }, today, today)).toEqual({ from: '2026-11-10', to: '2026-11-15', days: 6 });
  });

  it('allows at most 366 days, ending today or earlier, from on or before to', () => {
    expect(resolveRange({ from: '2025-11-15', to: today }, today, today)).toMatchObject({ days: 366 });
    expect(resolveRange({ from: '2025-11-14', to: today }, today, today)).toMatchObject({ invalid: 'from' });
    expect(resolveRange({ to: '2026-11-16' }, today, today)).toMatchObject({ invalid: 'to' });
    expect(resolveRange({ from: '2026-11-10', to: '2026-11-09' }, today, today)).toMatchObject({ invalid: 'from' });
    expect(resolveRange({ from: '2026-02-30' }, today, today)).toMatchObject({ invalid: 'from' });
    expect(resolveRange({ to: 'nope' }, today, today)).toMatchObject({ invalid: 'to' });
  });

  it('month helpers cross the year', () => {
    expect(monthStart('2026-03-31')).toBe('2026-03-01');
    expect(previousMonth('2026-01-10')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(previousMonth('2024-03-01')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
  });

  it('lists every date of a range', () => {
    expect(datesOf('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    expect(datesOf('2026-11-02', '2026-11-01')).toEqual([]);
  });
});

describe('dashboard figures', () => {
  it('links keep only real filters', () => {
    expect(linkTo('/collections', { from: '2026-11-01', branchId: undefined, method: 'cash' })).toEqual({ path: '/collections', query: { from: '2026-11-01', method: 'cash' } });
  });

  it('rates have 2 decimals and are null when nothing was decided', () => {
    expect(rate(1, 3)).toBe(0.33);
    expect(rate(2, 3)).toBe(0.67);
    expect(rate(0, 0)).toBeNull();
  });

  it('top rows are largest first with a stable tie-break', () => {
    const rows = [
      { k: 'b', v: 5 },
      { k: 'a', v: 5 },
      { k: 'c', v: 9 },
      { k: 'd', v: 1 },
    ];
    expect(topBy(rows, (r) => r.v, (r) => r.k, 3).map((r) => r.k)).toEqual(['c', 'a', 'b']);
    expect(topBy([{ k: 'x', v: 1 }, { k: 'x', v: 1 }], (r) => r.v, (r) => r.k, 5)).toHaveLength(2);
  });
});
