import { describe, expect, it } from 'vitest';
import { dueToApply, dueToRevert, transition } from '../domain/lifecycle.js';

describe('handover lifecycle', () => {
  it('only pending can be accepted/rejected/cancelled/expired', () => {
    expect(transition('pending_acceptance', 'accept')).toBe('accepted');
    expect(transition('accepted', 'accept')).toBeNull();
    expect(transition('rejected', 'cancel')).toBeNull();
    expect(transition('pending_acceptance', 'expire')).toBe('expired');
  });
  it('only accepted can revert', () => {
    expect(transition('accepted', 'revert')).toBe('reverted');
    expect(transition('pending_acceptance', 'revert')).toBeNull();
  });
  it('applies on effective date and reverts the day after endDate', () => {
    const h = { status: 'accepted', appliedAt: null, effectiveDate: '2026-11-16', endDate: '2026-11-20' };
    expect(dueToApply(h, '2026-11-15')).toBe(false);
    expect(dueToApply(h, '2026-11-16')).toBe(true);
    const applied = { ...h, appliedAt: new Date() };
    expect(dueToRevert(applied, '2026-11-20')).toBe(false);
    expect(dueToRevert(applied, '2026-11-21')).toBe(true);
  });
});
