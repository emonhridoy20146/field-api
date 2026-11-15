/** Handover state machine (FR-HO-001/006). Pure. */
export type HandoverStatus = 'pending_acceptance' | 'accepted' | 'rejected' | 'cancelled' | 'expired' | 'reverted';
export type HandoverAction = 'accept' | 'reject' | 'cancel' | 'expire' | 'revert';

const NEXT: Record<HandoverAction, { from: HandoverStatus[]; to: HandoverStatus }> = {
  accept: { from: ['pending_acceptance'], to: 'accepted' },
  reject: { from: ['pending_acceptance'], to: 'rejected' },
  cancel: { from: ['pending_acceptance'], to: 'cancelled' },
  expire: { from: ['pending_acceptance'], to: 'expired' },
  revert: { from: ['accepted'], to: 'reverted' },
};

export function transition(status: HandoverStatus, action: HandoverAction): HandoverStatus | null {
  const n = NEXT[action];
  return n.from.includes(status) ? n.to : null;
}

export const EXPIRY_HOURS = 72;
export const REMIND_AFTER_HOURS = 24;

/** Is the accepted handover due to apply / revert on this business date? */
export const dueToApply = (h: { status: string; appliedAt: Date | null; effectiveDate: string }, today: string) => h.status === 'accepted' && !h.appliedAt && h.effectiveDate <= today;
export const dueToRevert = (h: { status: string; appliedAt: Date | null; endDate: string | null }, today: string) => h.status === 'accepted' && !!h.appliedAt && !!h.endDate && h.endDate < today;
