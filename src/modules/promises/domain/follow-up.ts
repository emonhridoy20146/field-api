/** Pure follow-up chain rules (FR-PRM-006). A broken promise keeps its status; the follow-up is a new promise. */
import { diffDays } from '../../../core/time/index.js';

export type FollowUpProblem = 'NOT_FOUND' | 'OTHER_CUSTOMER' | 'NOT_BROKEN';

/** Only a promise that ended badly can be followed up. */
export const FOLLOW_UP_STATUSES = ['broken', 'partially_kept'] as const;

export interface ChainLink {
  id: string;
  customerId: string;
  status: string;
  /** Missing on promises made before 1.45.0: they read as attempt 1. */
  attempt?: number | null;
  /** Missing on promises made before 1.45.0: they read as their own root. */
  chainRootId?: string | null;
}

/** Why `parent` cannot be followed up by a new promise of `customerId`; null when it can. */
export function followUpProblem(parent: ChainLink | null, customerId: string): FollowUpProblem | null {
  if (!parent) return 'NOT_FOUND';
  if (parent.customerId !== customerId) return 'OTHER_CUSTOMER';
  if (!(FOLLOW_UP_STATUSES as readonly string[]).includes(parent.status)) return 'NOT_BROKEN';
  return null;
}

export const attemptOf = (p: Pick<ChainLink, 'attempt'>): number => (typeof p.attempt === 'number' && p.attempt >= 1 ? p.attempt : 1);
export const chainRootOf = (p: Pick<ChainLink, 'id' | 'chainRootId'>): string => p.chainRootId || p.id;

/** Where a follow-up of `parent` sits in the chain. */
export function nextInChain(parent: ChainLink): { attempt: number; chainRootId: string } {
  return { attempt: attemptOf(parent) + 1, chainRootId: chainRootOf(parent) };
}

/** The newest follow-up that is not cancelled, or null (what the parent's `followUpId` shows). */
export function newestFollowUp(children: { id: string; status: string; createdAt: Date }[]): string | null {
  let best: { id: string; createdAt: Date } | null = null;
  for (const c of children) {
    if (c.status === 'cancelled') continue;
    if (!best || c.createdAt > best.createdAt || (c.createdAt.getTime() === best.createdAt.getTime() && c.id > best.id)) best = c;
  }
  return best?.id ?? null;
}

/** The office is alerted once a badly ended promise has waited `days` Dhaka days or more without a follow-up. */
export const followUpOverdue = (closedDate: string, today: string, days: number): boolean => diffDays(closedDate, today) >= Math.max(0, days);
