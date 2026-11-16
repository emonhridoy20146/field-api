/** Pure matching of FOS collections against ERP field payments for one day (FR-COL-014). No I/O. */

export interface FosRow {
  id: string;
  receiptNo: string;
  amountPoisha: number;
  status: string;
  erpKey: string;
  erpPaymentId: string | null;
}
export interface ErpRow {
  erpPaymentId: string;
  idempotencyKey: string | null;
  receiptNo: string | null;
  amountPoisha: number;
  reversed: boolean;
}

export type MismatchKind = 'not_posted' | 'missing_in_erp' | 'missing_in_fos' | 'amount_differs' | 'reversed_in_erp' | 'voided_in_fos';
export interface Mismatch {
  kind: MismatchKind;
  collectionId: string | null;
  receiptNo: string | null;
  erpPaymentId: string | null;
  fosAmountPoisha: number | null;
  erpAmountPoisha: number | null;
  status: string | null;
}

const POSTED = ['posted', 'resolved_posted'];
const WAITING = ['received', 'posting', 'conflict', 'posting_failed'];

export function reconcileDay(fos: FosRow[], erp: ErpRow[]) {
  const byPayment = new Map(erp.map((p) => [p.erpPaymentId, p]));
  const byKey = new Map(erp.filter((p) => p.idempotencyKey).map((p) => [p.idempotencyKey!, p]));
  const used = new Set<string>();
  const mismatches: Mismatch[] = [];
  const totals = { fosPostedCount: 0, fosPostedPoisha: 0, fosWaitingCount: 0, fosWaitingPoisha: 0, erpCount: 0, erpPoisha: 0, matchedCount: 0 };
  const row = (kind: MismatchKind, c: FosRow | null, p: ErpRow | null): Mismatch => ({ kind, collectionId: c?.id ?? null, receiptNo: c?.receiptNo ?? p?.receiptNo ?? null, erpPaymentId: p?.erpPaymentId ?? c?.erpPaymentId ?? null, fosAmountPoisha: c?.amountPoisha ?? null, erpAmountPoisha: p?.amountPoisha ?? null, status: c?.status ?? null });

  for (const c of fos) {
    const p = (c.erpPaymentId ? byPayment.get(c.erpPaymentId) : undefined) ?? byKey.get(c.erpKey) ?? null;
    if (p) used.add(p.erpPaymentId);
    if (POSTED.includes(c.status)) {
      totals.fosPostedCount++;
      totals.fosPostedPoisha += c.amountPoisha;
      if (!p) mismatches.push(row('missing_in_erp', c, null));
      else if (p.reversed) mismatches.push(row('reversed_in_erp', c, p));
      else if (p.amountPoisha !== c.amountPoisha) mismatches.push(row('amount_differs', c, p));
      else totals.matchedCount++;
    } else if (WAITING.includes(c.status)) {
      totals.fosWaitingCount++;
      totals.fosWaitingPoisha += c.amountPoisha;
      mismatches.push(row('not_posted', c, p));
    } else if (p && !p.reversed) {
      // Voided (or otherwise not counted) here, yet the ERP holds a live payment for it.
      mismatches.push(row('voided_in_fos', c, p));
    }
  }
  for (const p of erp) {
    if (!p.reversed) {
      totals.erpCount++;
      totals.erpPoisha += p.amountPoisha;
    }
    if (!used.has(p.erpPaymentId) && !p.reversed) mismatches.push(row('missing_in_fos', null, p));
  }
  return { totals, mismatches, balanced: mismatches.length === 0 };
}
