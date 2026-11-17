import { describe, expect, it } from 'vitest';
import { achievement, effective, inForce, round2, type TargetRecord } from '../domain/resolve.js';

const rec = (over: Partial<TargetRecord>): TargetRecord => ({ id: 'x', userId: 'u1', kind: 'set', amountPoisha: 100, visits: 5, effectiveFrom: '2026-11-01', setAt: new Date('2026-11-01T00:00:00Z'), ...over });

describe('target in force (FR-COL-015)', () => {
  it('takes the latest effectiveFrom on or before the date, later change on the same day', () => {
    const a = rec({ id: 'a', effectiveFrom: '2026-11-01' });
    const b = rec({ id: 'b', effectiveFrom: '2026-11-10', setAt: new Date('2026-11-09T12:00:00Z') });
    const c = rec({ id: 'c', effectiveFrom: '2026-11-10', setAt: new Date('2026-11-09T00:00:00Z') });
    expect(inForce([a, b, c], '2026-10-31')).toBeNull();
    expect(inForce([a, b, c], '2026-11-09')!.id).toBe('a');
    expect(inForce([c, b, a], '2026-11-10')!.id).toBe('b');
    expect(inForce([], '2026-11-10')).toBeNull();
  });

  it('personal wins, cleared hands back to the branch, nothing means zero', () => {
    const branch = [rec({ id: 'br', userId: null, amountPoisha: 500000, visits: 8 })];
    expect(effective([], branch, '2026-11-15')).toMatchObject({ amountPoisha: 500000, visits: 8, source: 'branch' });
    const mine = [rec({ id: 'p', amountPoisha: 700000, visits: 10, effectiveFrom: '2026-11-12' })];
    expect(effective(mine, branch, '2026-11-11').source).toBe('branch');
    expect(effective(mine, branch, '2026-11-12')).toMatchObject({ amountPoisha: 700000, visits: 10, source: 'personal' });
    const cleared = [...mine, rec({ id: 'clr', kind: 'cleared', amountPoisha: null, visits: null, effectiveFrom: '2026-11-14' })];
    expect(effective(cleared, branch, '2026-11-15')).toMatchObject({ amountPoisha: 500000, source: 'branch' });
    expect(effective([], [], '2026-11-15')).toEqual({ amountPoisha: 0, visits: 0, source: 'branch', record: null });
    const branchCleared = [...branch, rec({ id: 'bc', userId: null, kind: 'cleared', effectiveFrom: '2026-11-13' })];
    expect(effective([], branchCleared, '2026-11-15')).toMatchObject({ amountPoisha: 0, visits: 0, source: 'branch' });
  });

  it('achievement is a 2-decimal ratio, null without a target', () => {
    expect(achievement(150, 200)).toBe(0.75);
    expect(achievement(1, 3)).toBe(0.33);
    expect(achievement(5, 0)).toBeNull();
    expect(achievement(5, Number.NaN)).toBeNull();
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });
});
