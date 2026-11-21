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

/**
 * Which cash is still in hand (FR-CASH-007): deposits pay off collections oldest-first, so the cash in hand is the
 * newest collections. A collection only partly covered keeps the rest. `collections` must be oldest first.
 */
export function inHandBreakdown<T extends { amountPoisha: number }>(collections: T[], depositsPoisha: number): (T & { inHandPoisha: number })[] {
  let left = Math.max(0, depositsPoisha);
  const out: (T & { inHandPoisha: number })[] = [];
  for (const c of collections) {
    const covered = Math.min(left, c.amountPoisha);
    left -= covered;
    if (c.amountPoisha - covered > 0) out.push({ ...c, inHandPoisha: c.amountPoisha - covered });
  }
  return out;
}


/**
 * Which collections one deposit covered (FR-CASH-008). Deposits (pending and verified, oldest first) pay off cash
 * collections oldest-first, the same order `inHandBreakdown` uses, so a deposit's collections and the cash still in
 * hand never overlap or leave a gap. The deposits before `depositId` consume the oldest collections; this deposit
 * covers the next ones, the first and the last possibly only in part. Money the deposit has over what was collected
 * is `unmatchedPoisha` (a collection voided after the deposit). `collections` and `deposits` must be oldest first.
 */
export function depositCoverage<T extends { amountPoisha: number }>(
  collections: T[],
  deposits: { id: string; amountPoisha: number }[],
  depositId: string,
): { items: (T & { coveredPoisha: number })[]; coveredPoisha: number; unmatchedPoisha: number } | null {
  const at = deposits.findIndex((d) => d.id === depositId);
  if (at < 0) return null;
  let skip = deposits.slice(0, at).reduce((n, d) => n + Math.max(0, d.amountPoisha), 0);
  let left = Math.max(0, deposits[at]!.amountPoisha);
  const items: (T & { coveredPoisha: number })[] = [];
  for (const c of collections) {
    const skipped = Math.min(skip, c.amountPoisha);
    skip -= skipped;
    const free = c.amountPoisha - skipped;
    if (free <= 0) continue;
    if (left <= 0) break;
    const covered = Math.min(left, free);
    left -= covered;
    items.push({ ...c, coveredPoisha: covered });
  }
  return { items, coveredPoisha: items.reduce((n, c) => n + c.coveredPoisha, 0), unmatchedPoisha: left };
}
