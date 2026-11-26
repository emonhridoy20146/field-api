/**
 * FR-CUS-019 (1.29.0): the list filter "paid this month / not paid this month" for the owner's question
 * "who has paid something this month, and who has not". A customer counts as paid in the Dhaka month when
 *   - an ERP payment dated in the month is on the customer (removed / reversed ones left out, and since 1.53.0
 *     payments to a returned invoice, flagged `returned` when stored — FR-CUS-024), or
 *   - a field collection recorded in the month is still waiting for the ERP (the pending money of FR-CUS-017).
 * The second part lives in the collections module, which hands over the customer ids; this rule only shapes
 * the Mongo filter. Same two sources as the row's `activity` (`paidPoisha` / `pendingPoisha`), so the filter
 * and the row mark never disagree.
 */
export type PaidThisMonth = 'yes' | 'no';

export const PAID_THIS_MONTH: PaidThisMonth[] = ['yes', 'no'];

/** `month` is `YYYY-MM` (Dhaka). `pendingCustomerIds` are the customers with a pending field collection of the month. */
export function paidThisMonthFilter(want: PaidThisMonth, month: string, pendingCustomerIds: unknown[]): Record<string, unknown> {
  const paidInErp = {
    recentPayments: { $elemMatch: { date: { $gte: `${month}-01`, $lte: `${month}-31` }, reversed: { $ne: true }, returned: { $ne: true } } },
  };
  const parts: Record<string, unknown>[] = [paidInErp];
  if (pendingCustomerIds.length) parts.push({ _id: { $in: pendingCustomerIds } });
  return want === 'yes' ? { $or: parts } : { $nor: parts };
}
