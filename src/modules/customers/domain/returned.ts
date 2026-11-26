/**
 * FR-CUS-023 / ADR-068 (owner request 2026-11-26): invoices returned in the ERP are not shown to any client.
 *
 * They are kept apart from the plans FOS shows (`erp_customers.returnedPlans`, not `plans`), so every read,
 * filter, search, count and sync payload that works on `plans` leaves them out without a filter of its own.
 * The ERP still owns them; FOS only stops showing them. The customer itself stays visible.
 */
export interface ReturnablePlan {
  erpPlanId: string;
  returned?: boolean;
  invoiceStatus?: string | null;
}

/**
 * Returned = flagged by the mapper (1.50.0) or, for plans cached before 1.50.0, the ERP invoice status
 * stored since 1.14.0. A plan cached before 1.14.0 has neither and is read as not returned until the next
 * ERP read of that customer re-maps it.
 */
export function isReturnedPlan(p: ReturnablePlan): boolean {
  return p.returned === true || (p.invoiceStatus ?? '').trim().toLowerCase() === 'returned';
}

/** Splits ERP plans into the ones FOS shows and the returned ones it keeps out of sight (order kept). */
export function splitReturned<T extends ReturnablePlan>(plans: T[]): { visible: T[]; returned: (T & { returned: true })[] } {
  const visible: T[] = [];
  const returned: (T & { returned: true })[] = [];
  for (const p of plans) {
    if (isReturnedPlan(p)) returned.push({ ...p, returned: true });
    else visible.push(p);
  }
  return { visible, returned };
}

/**
 * Merges newly found returned plans into the ones already set aside (by erpPlanId, newest wins). Used by the
 * one-off migration so a second run, or a run after an ERP sync, changes nothing.
 */
export function mergeReturned<T extends ReturnablePlan>(already: T[], found: T[]): T[] {
  const byId = new Map<string, T>();
  for (const p of already) byId.set(p.erpPlanId, p);
  for (const p of found) byId.set(p.erpPlanId, p);
  return [...byId.values()];
}

// ---------------- 1.53.0 (FR-CUS-024, ADR-071 amends ADR-068): returned invoices are shown, never counted ----------------

/** The ERP payment fields the returned-payment rule reads (the cached `recentPayments` of the customer). */
export interface ReturnablePayment {
  erpPlanId?: string | null;
  returned?: boolean;
}

/**
 * A payment belongs to a returned invoice when the ERP posted it against one (`erpPlanId`, the ERP
 * `sales_invoice_id`, is one of the customer's returned invoices) or it was flagged so when stored. A payment
 * without an invoice cannot be tied to one and is never treated as returned (it keeps counting, as before 1.53.0).
 */
export function isReturnedPayment(p: ReturnablePayment, returnedIds: ReadonlySet<string>): boolean {
  if (p.returned === true) return true;
  return typeof p.erpPlanId === 'string' && p.erpPlanId !== '' && returnedIds.has(p.erpPlanId);
}

/**
 * Stores the rule on each cached payment (`returned: true`) so the Mongo filter "paid this month" can leave these
 * payments out without knowing the invoices. Recomputed from scratch on every ERP read: a flag from an earlier read
 * is dropped when the invoice is no longer returned. Order and every other field are kept.
 */
export function markReturnedPayments<T extends ReturnablePayment>(payments: T[], returnedIds: ReadonlySet<string>): T[] {
  return payments.map((p) => {
    const { returned: _old, ...rest } = p;
    const tied = typeof p.erpPlanId === 'string' && p.erpPlanId !== '' && returnedIds.has(p.erpPlanId);
    return (tied ? { ...rest, returned: true } : rest) as T;
  });
}

/** erpPlanIds of the returned invoices (as strings). */
export const returnedIdSet = (returnedPlans: { erpPlanId?: unknown }[] | null | undefined): Set<string> =>
  new Set((returnedPlans ?? []).map((p) => String(p.erpPlanId)));

/**
 * The marker lists use for a customer with returned invoices. `invoiceCount` is the customer's shown invoices as
 * counted for the list (`invoiceCount.total`: cancelled ones not counted). `onlyReturned` = the customer has
 * invoices and every one of them was returned: clients show a "returned product customer" marker and do not open
 * the row. A customer with no invoice at all is not `onlyReturned`.
 */
export function returnedMarker(returnedCount: number, shownInvoiceCount: number): { returnedInvoiceCount: number; onlyReturned: boolean } {
  return { returnedInvoiceCount: returnedCount, onlyReturned: returnedCount > 0 && shownInvoiceCount === 0 };
}
