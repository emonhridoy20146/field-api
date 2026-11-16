import { describe, expect, it } from 'vitest';
import { computePrimary, type ActiveAssignment } from '../domain/primary.js';

const d = (s: string) => new Date(s);
describe('computePrimary (FR-ASG-002)', () => {
  const areaOf = new Map([['c1', 'A'], ['c2', 'A'], ['c3', 'B']]);
  it('area assignment covers its customers; uncovered are unassigned', () => {
    const r = computePrimary(['c1', 'c2', 'c3', 'c4'], areaOf, [{ id: '1', userId: 'u1', type: 'area', areaId: 'A', effectiveFrom: d('2026-11-01') }]);
    expect(r.get('c1')).toEqual({ assigneeId: 'u1', areaId: 'A' });
    expect(r.get('c3')).toEqual({ assigneeId: null, areaId: 'B' });
    expect(r.get('c4')).toEqual({ assigneeId: null, areaId: null });
  });
  it('direct overrides area', () => {
    const a: ActiveAssignment[] = [
      { id: '1', userId: 'u1', type: 'area', areaId: 'A', effectiveFrom: d('2026-11-01') },
      { id: '2', userId: 'u2', type: 'customer', customerId: 'c2', effectiveFrom: d('2026-10-01') },
    ];
    const r = computePrimary(['c1', 'c2'], areaOf, a);
    expect(r.get('c1')!.assigneeId).toBe('u1');
    expect(r.get('c2')!.assigneeId).toBe('u2');
  });
  it('newest wins on duplicates', () => {
    const r = computePrimary(['c1'], areaOf, [
      { id: '1', userId: 'u1', type: 'customer', customerId: 'c1', effectiveFrom: d('2026-11-01') },
      { id: '2', userId: 'u2', type: 'customer', customerId: 'c1', effectiveFrom: d('2026-11-02') },
    ]);
    expect(r.get('c1')!.assigneeId).toBe('u2');
  });
});
