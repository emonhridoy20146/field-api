/**
 * 1.44.0 (FR-CUS-021, owner request): who did this month's work on a customer, so the staff app can say
 * "visited by", "paid to" and "promised by" by name instead of only counts.
 *
 * Money stays apart (CLAUDE.md §2.1): ERP payments and field money not in the ERP yet are separate entries
 * (`pending`), never summed together. Nothing here is a balance; it only labels money the row already shows.
 */

/** One staff member's part of this month's visits or promises. */
export interface ActivityPerson {
  userId: string;
  name: string;
  count: number;
  lastAt: string;
}

/** A field collection of the month, as the collections module hands it over. */
export interface MonthCollectionRef {
  idempotencyKey: string;
  userId: string;
  name: string;
  amountPoisha: number;
  businessDate: string;
  /** Recorded in FOS and not in the ERP yet. */
  pending: boolean;
}

/** The ERP payment fields this rule reads (the cached `recentPayments` of the customer). */
export interface MonthPaymentRef {
  date?: unknown;
  amountPoisha?: unknown;
  reversed?: unknown;
  idempotencyKey?: unknown;
  collectorName?: unknown;
  referenceName?: unknown;
}

/**
 * Where the name of a payer entry comes from:
 * - `staff`: the FOS staff member who collected it (a field collection, matched to its ERP payment by idempotency key);
 * - `erp_referrer`: the ERP employee recorded on the payment (an office/ERP payment);
 * - `collector_name`: the collector name a payment was posted with when there was no ERP employee (ADR-049);
 * - `unknown`: the ERP gave no name (an office payment without a referrer); `name` is empty.
 */
export type PaidBySource = 'staff' | 'erp_referrer' | 'collector_name' | 'unknown';

export interface PaidByEntry {
  name: string;
  source: PaidBySource;
  userId?: string;
  amountPoisha: number;
  lastDate: string;
  pending: boolean;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Payments of the Dhaka month `month` (YYYY-MM) grouped by who took them, newest first. ERP payments dated in the
 * month (removed ones left out) and field collections of the month still waiting for the ERP; the two never merge.
 */
export function paidByOfMonth(month: string, payments: MonthPaymentRef[], collections: MonthCollectionRef[]): PaidByEntry[] {
  const byKey = new Map(collections.map((c) => [c.idempotencyKey, c]));
  const out = new Map<string, PaidByEntry>();
  const add = (e: Omit<PaidByEntry, 'amountPoisha' | 'lastDate'>, amount: number, date: string) => {
    const k = `${e.pending ? 'p' : 'e'}|${e.source}|${e.userId ?? e.name}`;
    const cur = out.get(k);
    if (cur) {
      cur.amountPoisha += amount;
      if (date > cur.lastDate) cur.lastDate = date;
    } else out.set(k, { ...e, amountPoisha: amount, lastDate: date });
  };
  for (const p of payments) {
    if (p.reversed || typeof p.date !== 'string' || !p.date.startsWith(month)) continue;
    const amount = typeof p.amountPoisha === 'number' ? p.amountPoisha : 0;
    const staff = typeof p.idempotencyKey === 'string' ? byKey.get(p.idempotencyKey) : undefined;
    if (staff) add({ name: staff.name, source: 'staff', userId: staff.userId, pending: false }, amount, p.date);
    else if (text(p.collectorName)) add({ name: text(p.collectorName), source: 'erp_referrer', pending: false }, amount, p.date);
    else if (text(p.referenceName)) add({ name: text(p.referenceName), source: 'collector_name', pending: false }, amount, p.date);
    else add({ name: '', source: 'unknown', pending: false }, amount, p.date);
  }
  for (const c of collections) {
    if (!c.pending || !c.businessDate.startsWith(month)) continue;
    add({ name: c.name, source: 'staff', userId: c.userId, pending: true }, c.amountPoisha, c.businessDate);
  }
  return [...out.values()].sort((a, b) => b.lastDate.localeCompare(a.lastDate) || Number(a.pending) - Number(b.pending));
}
