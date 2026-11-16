/** Pure cash-on-hand rules (FR-CASH-001/002/005). */
export type CashState = 'ok' | 'warning' | 'exceeded';

export function onHand(cashCollectedPoisha: number, depositsPoisha: number): number {
  return Math.max(0, cashCollectedPoisha - depositsPoisha);
}

/** Warning at 80 % of the limit, exceeded at 100 %. */
export function stateOf(onHandPoisha: number, limitPoisha: number): CashState {
  if (limitPoisha <= 0) return 'ok';
  if (onHandPoisha >= limitPoisha) return 'exceeded';
  if (onHandPoisha >= limitPoisha * 0.8) return 'warning';
  return 'ok';
}

/** Oldest cash still in hand: deposits pay off collections oldest-first (FIFO). */
export function oldestUndeposited(collections: { at: Date; amountPoisha: number }[], depositsPoisha: number): Date | null {
  let left = depositsPoisha;
  for (const c of collections) {
    if (left >= c.amountPoisha) {
      left -= c.amountPoisha;
      continue;
    }
    return c.at;
  }
  return null;
}
