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
