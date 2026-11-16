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
