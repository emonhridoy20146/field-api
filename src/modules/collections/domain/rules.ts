/** Pure collection rules (FR-COL-001/002/013). */

export const METHODS = ['cash', 'bkash', 'nagad', 'rocket', 'bank_transfer', 'other_mobile'] as const;
export type Method = (typeof METHODS)[number];
export type Flag = 'far_from_pin' | 'mock_location' | 'clock_skew' | 'late_sync' | 'duplicate_txn_ref' | 'not_in_scope_at_record_time' | 'no_location';

/** Default per-method transaction id patterns (setting `collections.txnRefPatterns` overrides). */
export const DEFAULT_TXN_PATTERNS: Record<Exclude<Method, 'cash'>, string> = {
  bkash: '^[A-Z0-9]{10}$',
  nagad: '^[A-Z0-9]{8,12}$',
  rocket: '^[A-Z0-9]{8,12}$',
  bank_transfer: '^[A-Z0-9/-]{4,40}$',
  other_mobile: '^[A-Z0-9/-]{4,40}$',
};

export const normalizeTxnRef = (s: string | undefined | null) => (s ? s.trim().toUpperCase().replace(/\s+/g, '') : null);

/** null = ok; otherwise a validation message. */
export function checkTxnRef(method: Method, ref: string | null, patterns: Record<string, string>): string | null {
  if (method === 'cash') return null;
  if (!ref) return 'transactionRef is required for non-cash methods';
  const p = patterns[method] ?? DEFAULT_TXN_PATTERNS[method];
  return new RegExp(p).test(ref) ? null : `transactionRef does not match the ${method} format`;
}

/** `{BRANCHCODE}-{STAFFCODE}-{YYMMDD}-{SEQ4}` */
export const RECEIPT_RE = /^([A-Z0-9]{2,10})-([A-Z0-9]{2,10})-(\d{6})-(\d{4})$/;
export const receiptPrefix = (branchCode: string, staffCode: string) => `${branchCode}-${staffCode}`.toUpperCase();
export const formatReceipt = (prefix: string, yymmdd: string, seq: number) => `${prefix}-${yymmdd}-${String(seq).padStart(4, '0')}`;

export function checkReceipt(receiptNo: string, expectedPrefix: string): string | null {
  const m = RECEIPT_RE.exec(receiptNo);
  if (!m) return 'receiptNo must look like BRL01-FS014-261115-0007';
  if (`${m[1]}-${m[2]}` !== expectedPrefix) return `receiptNo prefix must be ${expectedPrefix}`;
  return null;
}

export interface FlagInput {
  distanceToPinM: number | null;
  geofenceM: number;
  mock: boolean;
  noLocation?: boolean;
  recordedAt: Date;
  deviceTime: Date | null;
  receivedAt: Date;
  duplicateTxnRef: boolean;
  collectorIsAssignee: boolean;
}

/** Flags never block (FR-COL-013); they feed the inbox. */
export function computeFlags(f: FlagInput): Flag[] {
  const out: Flag[] = [];
  if (f.distanceToPinM !== null && f.distanceToPinM > f.geofenceM) out.push('far_from_pin');
  if (f.mock) out.push('mock_location');
  const skewMs = f.deviceTime ? Math.abs(f.deviceTime.getTime() - f.recordedAt.getTime()) : 0;
  if (skewMs > 5 * 60_000 || f.recordedAt.getTime() - f.receivedAt.getTime() > 5 * 60_000) out.push('clock_skew');
  if (f.receivedAt.getTime() - f.recordedAt.getTime() > 12 * 3_600_000) out.push('late_sync');
  if (f.duplicateTxnRef) out.push('duplicate_txn_ref');
  if (!f.collectorIsAssignee) out.push('not_in_scope_at_record_time');
  if (f.noLocation) out.push('no_location');
  return out;
}

/** Plan choice: explicit, or the only active plan (FR-COL-001). */
export function choosePlan(plans: { erpPlanId: string; status: string }[], requested: string | undefined): { ok: true; erpPlanId: string } | { ok: false; message: string } {
  if (requested) return { ok: true, erpPlanId: requested };
  const active = plans.filter((p) => p.status === 'active');
  if (active.length === 1) return { ok: true, erpPlanId: active[0]!.erpPlanId };
  return { ok: false, message: active.length ? 'erpPlanId is required when the customer has more than one active plan' : 'customer has no active plan; erpPlanId is required' };
}

export type Status = 'received' | 'posting' | 'posted' | 'conflict' | 'posting_failed' | 'resolved_posted' | 'resolved_refund' | 'resolved_voided' | 'voided';
export const PENDING_STATUSES: Status[] = ['received', 'posting', 'posting_failed', 'conflict'];
/** Cash that is still in the collector's hand (FR-CASH-001). */
export const CASH_COUNTED_STATUSES: Status[] = ['received', 'posting', 'posted', 'conflict', 'posting_failed', 'resolved_posted'];
export const VOIDABLE: Status[] = ['received', 'posting_failed'];
export const RESOLVABLE: Status[] = ['conflict', 'posting_failed'];

export const CONFLICT_TEXT: Record<string, { en: string; bn: string }> = {
  PLAN_SETTLED: { en: 'Plan already settled in ERP', bn: 'কিস্তি আগেই পরিশোধিত' },
  AMOUNT_EXCEEDS_OUTSTANDING: { en: 'Amount is more than the outstanding balance', bn: 'টাকার পরিমাণ বাকির চেয়ে বেশি' },
  PLAN_NOT_FOUND: { en: 'Plan not found in ERP', bn: 'ইআরপিতে কিস্তি পাওয়া যায়নি' },
  CUSTOMER_INACTIVE: { en: 'Customer is inactive in ERP', bn: 'গ্রাহক ইআরপিতে নিষ্ক্রিয়' },
  PERIOD_LOCKED: { en: 'Accounting period is locked', bn: 'হিসাবের সময়কাল বন্ধ' },
  ERP_VALIDATION: { en: 'ERP rejected the payment', bn: 'ইআরপি পেমেন্ট গ্রহণ করেনি' },
  GAVE_UP: { en: 'Could not post to ERP for 24 hours', bn: '২৪ ঘণ্টায় ইআরপিতে পোস্ট করা যায়নি' },
};
