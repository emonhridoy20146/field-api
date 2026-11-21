/** Pure promise rules (FR-PRM-001/003). Dates are Dhaka business dates (YYYY-MM-DD). */
import { addDays } from '../../../core/time/index.js';

export const MAX_DAYS_AHEAD = 60;

export function dateInRange(promisedDate: string, today: string): boolean {
  return promisedDate >= today && promisedDate <= addDays(today, MAX_DAYS_AHEAD);
}

export type Outcome = 'kept' | 'partially_kept' | 'broken';

/** Final verdict once the promised date + grace has passed. */
export function verdict(paidPoisha: number, promisedPoisha: number): Outcome {
  if (paidPoisha >= promisedPoisha) return 'kept';
  return paidPoisha > 0 ? 'partially_kept' : 'broken';
}

/** The promise can be judged on `today` when the promised date plus grace days is over. */
export const isDue = (promisedDate: string, graceDays: number, today: string) => addDays(promisedDate, graceDays) < today;

export interface PromiseLike {
  id: string;
  customerId: string;
  erpPlanId: string | null;
  createdDate: string;
  promisedDate: string;
  status: string;
}

/**
 * The promise a collection was made against (FR-CASH-008): same customer, same invoice (a promise without an
 * invoice covers any), made on or before the collection's business date and not yet past its promised date plus
 * grace on that day. Several match → the newest one. Cancelled / superseded promises never match.
 */
export function promiseFor<P extends PromiseLike>(promises: P[], c: { customerId: string; erpPlanId: string | null; businessDate: string }, graceDays: number): P | null {
  let best: P | null = null;
  for (const p of promises) {
    if (p.customerId !== c.customerId) continue;
    if (p.status === 'cancelled' || p.status === 'superseded') continue;
    if (p.erpPlanId && c.erpPlanId && p.erpPlanId !== c.erpPlanId) continue;
    if (p.createdDate > c.businessDate) continue;
    if (addDays(p.promisedDate, graceDays) < c.businessDate) continue;
    if (!best || p.createdDate > best.createdDate || (p.createdDate === best.createdDate && p.promisedDate > best.promisedDate)) best = p;
  }
  return best;
}
