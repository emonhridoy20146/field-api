/** Pure target rules (FR-COL-015). No database, no clock. */

export interface TargetRecord {
  id: string;
  /** null = branch default. */
  userId: string | null;
  kind: 'set' | 'cleared';
  amountPoisha: number | null;
  visits: number | null;
  effectiveFrom: string;
  setAt: Date;
}

export interface Effective {
  amountPoisha: number;
  visits: number;
  source: 'personal' | 'branch';
  /** The record that decided the values; null when nothing was ever set. */
  record: TargetRecord | null;
}

/** The record in force on `date`: the latest effectiveFrom on or before it; same day → the later change. */
export function inForce(records: TargetRecord[], date: string): TargetRecord | null {
  let best: TargetRecord | null = null;
  for (const r of records) {
    if (r.effectiveFrom > date) continue;
    if (!best || r.effectiveFrom > best.effectiveFrom || (r.effectiveFrom === best.effectiveFrom && r.setAt > best.setAt)) best = r;
  }
  return best;
}

/** A personal target wins over the branch default; a "cleared" personal record hands back to the branch. */
export function effective(personal: TargetRecord[], branch: TargetRecord[], date: string): Effective {
  const p = inForce(personal, date);
  if (p && p.kind === 'set') return { amountPoisha: p.amountPoisha ?? 0, visits: p.visits ?? 0, source: 'personal', record: p };
  const b = inForce(branch, date);
  if (b && b.kind === 'set') return { amountPoisha: b.amountPoisha ?? 0, visits: b.visits ?? 0, source: 'branch', record: b };
  return { amountPoisha: 0, visits: 0, source: 'branch', record: b };
}

/** Achieved ÷ target with 2 decimals; null when there is no target to measure against. */
export function achievement(achieved: number, target: number): number | null {
  if (!(target > 0)) return null;
  return Math.round((achieved / target) * 100) / 100;
}

/** Visit targets may be fractional (co-work credit); keep sums tidy. */
export const round2 = (n: number) => Math.round(n * 100) / 100;
