import { z } from 'zod';
import { ctx } from '../../core/context/index.js';
import { AppError, notFound } from '../../core/errors/index.js';
import { isOid, type LeanDoc } from '../../core/db/index.js';
import { businessDate } from '../../core/time/index.js';
import { branchQuery, canSeeBranch, isSuperAdmin, type AuthUser } from '../../core/security/types.js';
import { flagsFor } from '../flags/index.js';
import { getUsers, listByRole } from '../users/index.js';
import { listBranches } from '../branches/index.js';
import { erpFieldPayments, getCustomerRefs, overdueAging, overdueSummary, scopeFilter as customerScope } from '../customers/index.js';
import { collectedByDay, collectedByUser, collectionRows } from '../collections/index.js';
import { visitsByDay, visitsByUser, visitSplitByUser } from '../visits/index.js';
import { visitCreditFor } from '../cowork/index.js';
import { achievement, targetsOf } from '../targets/index.js';
import { promiseStatsByOwner } from '../promises/index.js';
import { attendanceDays } from '../attendance/index.js';
import { fieldStatsByUser } from '../location/index.js';
import { bucketOf, buckets, reportRange, validRange, type Granularity } from './domain/period.js';
import { reconcileDay } from './domain/reconcile.js';
import { OverdueSnapshotModel } from './models/report.model.js';

const today = () => businessDate(ctx().clock.now());
const bad = (path: string, message: string) => new AppError('VALIDATION_FAILED', { fields: [{ path, message }] });

/** A branch outside the caller's scope is reported as not found, never as "forbidden" (CLAUDE.md §2.7). */
export function branchInScope(user: AuthUser, branchId: string | undefined): string | undefined {
  if (!branchId) return undefined;
  if (!isOid(branchId) || !canSeeBranch(user, branchId)) throw notFound('branch');
  return branchId;
}

export const performanceQuery = z.object({ branchId: z.string().max(64).optional(), period: z.enum(['daily', 'monthly']), date: z.string().max(10), userId: z.string().max(64).optional() });

/**
 * FR-REP-001. Figures are aggregated from the source collections at request time (ADR-028), so a
 * report always equals a raw query over the same period. Modules that are switched off contribute zeros.
 */
export async function staffPerformance(user: AuthUser, q: z.infer<typeof performanceQuery>) {
  const range = reportRange(q.period, q.date, today());
  if (!range) throw bad('date', q.period === 'daily' ? 'today or earlier (YYYY-MM-DD)' : 'this month or earlier (YYYY-MM)');
  const branchId = branchInScope(user, q.branchId);
  const all = await listByRole(['field_staff'], branchId ? [branchId] : isSuperAdmin(user) ? undefined : user.branchIds);
  const staff = q.userId ? all.filter((u) => u.id === q.userId) : all;
  if (q.userId && !staff.length) throw notFound('user');
  staff.sort((a, b) => a.employeeCode.localeCompare(b.employeeCode));

  const on = await flagsFor(user);
  const { from, to } = range;
  const collected = on['module.collections'] ? await collectedByUser(user, branchId, from, to) : new Map();
  const visits = on['module.visits'] ? await visitsByUser(user, branchId, from, to) : new Map();
  const split = on['module.visits'] ? await visitSplitByUser(user, branchId, from, to) : new Map<string, { solo: number; coWork: number }>();
  const promises = on['module.promises'] ? await promiseStatsByOwner(user, branchId, from, to) : new Map();
  const field = on['module.location'] ? await fieldStatsByUser(staff.map((s) => s.id), from, to) : new Map();
  const att = new Map<string, { presentDays: number; lateDays: number; lateMin: number; breakMin: number }>();
  if (on['module.attendance'])
    for (const d of await attendanceDays(user, { branchId, userId: q.userId, from, to })) {
      const a = att.get(d.userId) ?? { presentDays: 0, lateDays: 0, lateMin: 0, breakMin: 0 };
      if (d.firstIn !== null) a.presentDays++;
      if (d.firstIn !== null && d.lateMin > 0) a.lateDays++;
      a.lateMin += d.lateMin;
      a.breakMin += d.breakMin;
      att.set(d.userId, a);
    }

  const targets = on['module.targets'] ? await targetsOf(staff, from, to) : new Map<string, never>();
  const credit = new Map<string, number>();
  for (const s of staff) credit.set(s.id, await visitCreditFor(split.get(s.id)?.solo ?? 0, split.get(s.id)?.coWork ?? 0, s.branchIds[0]));

  return staff.map((s) => {
    const p = promises.get(s.id) ?? { due: 0, kept: 0, decided: 0 };
    const byMethod = (collected.get(s.id)?.byMethod ?? {}) as Record<string, number>;
    const total = Object.values(byMethod).reduce((a, b) => a + b, 0);
    const tg = targets.get(s.id);
    return {
      userId: s.id,
      name: s.name.en || s.name.bn,
      period: q.date,
      visits: visits.get(s.id)?.count ?? 0,
      uniqueCustomers: visits.get(s.id)?.uniqueCustomers ?? 0,
      // FR-CW-005: `visits` stays what the person recorded; joint visits credit every participant.
      soloVisits: split.get(s.id)?.solo ?? 0,
      coWorkVisits: split.get(s.id)?.coWork ?? 0,
      visitCredit: credit.get(s.id) ?? 0,
      collectionsCount: collected.get(s.id)?.count ?? 0,
      collectedPoisha: (collected.get(s.id)?.byMethod ?? {}) as Record<string, number>,
      // FR-COL-015: targets summed over the period's working days; achievement is measured to date.
      targetPoisha: tg?.amountPoisha ?? 0,
      visitTarget: tg?.visits ?? 0,
      targetToDatePoisha: tg?.amountToDatePoisha ?? 0,
      visitTargetToDate: tg?.visitsToDate ?? 0,
      amountAchievement: achievement(total, tg?.amountToDatePoisha ?? 0),
      visitAchievement: achievement(credit.get(s.id) ?? 0, tg?.visitsToDate ?? 0),
      targetDays: tg?.days ?? 0,
      promisesDue: p.due,
      promisesKept: p.kept,
      // Share of promises already decided (kept, partly kept, broken) that were fully kept.
      promiseFulfilmentRate: p.decided ? Math.round((p.kept / p.decided) * 100) / 100 : 0,
      ...(att.get(s.id) ?? { presentDays: 0, lateDays: 0, lateMin: 0, breakMin: 0 }),
      fieldMin: field.get(s.id)?.fieldMin ?? 0,
      distanceKm: field.get(s.id)?.distanceKm ?? 0,
    };
  });
}

export const trendsQuery = z.object({ branchId: z.string().max(64).optional(), from: z.string().max(10), to: z.string().max(10), granularity: z.enum(['day', 'week', 'month']).default('day') });

const emptyBuckets = () => ({ d1_30: { count: 0, amountPoisha: 0 }, d31_60: { count: 0, amountPoisha: 0 }, d61_90: { count: 0, amountPoisha: 0 }, d90p: { count: 0, amountPoisha: 0 } });
type Buckets = ReturnType<typeof emptyBuckets>;
const BUCKET_KEYS = ['d1_30', 'd31_60', 'd61_90', 'd90p'] as const;

async function liveOverdue(filter: Record<string, unknown>) {
  const s = await overdueSummary(filter);
  return { buckets: await overdueAging(filter), totalOverdue: { count: s.customers, amountPoisha: s.amountPoisha }, badSuggested: s.badSuggested, tagged: s.tagged };
}

/** FR-REP-002: collection trend per period, and the stored daily overdue picture (today is live). */
export async function branchTrends(user: AuthUser, q: z.infer<typeof trendsQuery>) {
  const t = today();
  if (!validRange(q.from, q.to, t, 366)) throw bad('to', 'from..to must end today or earlier and span at most 366 days');
  const branchId = branchInScope(user, q.branchId);
  const g: Granularity = q.granularity;
  const on = await flagsFor(user);
  const collected = on['module.collections'] ? await collectedByDay(user, branchId, q.from, q.to) : new Map<string, { totalPoisha: number; cashPoisha: number; mobilePoisha: number; count: number }>();
  const visits = on['module.visits'] ? await visitsByDay(user, branchId, q.from, q.to) : new Map<string, { count: number }>();
  const rows = new Map(buckets(q.from, q.to, g).map((k) => [k, { period: k, totalPoisha: 0, cashPoisha: 0, mobilePoisha: 0, count: 0, visits: 0 }]));
  for (const [d, c] of collected) {
    const r = rows.get(bucketOf(d, g));
    if (!r) continue;
    r.totalPoisha += c.totalPoisha;
    r.cashPoisha += c.cashPoisha;
    r.mobilePoisha += c.mobilePoisha;
    r.count += c.count;
  }
  for (const [d, v] of visits) {
    const r = rows.get(bucketOf(d, g));
    if (r) r.visits += v.count;
  }

  const snaps = (await OverdueSnapshotModel.find({ ...branchQuery(user, branchId), businessDate: { $gte: q.from, $lte: q.to, $ne: t } }).sort({ businessDate: 1 }).lean()) as LeanDoc[];
  const byDate = new Map<string, { date: string; buckets: Buckets; totalOverdue: { count: number; amountPoisha: number }; badSuggested: number; tagged: number }>();
  for (const s of snaps) {
    const d = byDate.get(s.businessDate) ?? { date: s.businessDate as string, buckets: emptyBuckets(), totalOverdue: { count: 0, amountPoisha: 0 }, badSuggested: 0, tagged: 0 };
    for (const k of BUCKET_KEYS) {
      d.buckets[k].count += s.buckets?.[k]?.count ?? 0;
      d.buckets[k].amountPoisha += s.buckets?.[k]?.amountPoisha ?? 0;
    }
    d.totalOverdue.count += s.totalOverdue?.count ?? 0;
    d.totalOverdue.amountPoisha += s.totalOverdue?.amountPoisha ?? 0;
    d.badSuggested += s.badSuggested ?? 0;
    d.tagged += s.tagged ?? 0;
    byDate.set(d.date, d);
  }
  const overdue = [...byDate.values()];
  if (q.to === t) overdue.push({ date: t, ...(await liveOverdue({ ...customerScope(user), ...(branchId ? branchQuery(user, branchId) : {}) })) });
  return { from: q.from, to: q.to, granularity: g, collection: [...rows.values()], overdue };
}

/** Nightly: freeze today's overdue picture per branch. Re-running replaces the day's row. */
export async function snapshotOverdue(date = today()): Promise<number> {
  const branches = await listBranches();
  for (const b of branches) {
    const live = await liveOverdue({ branchId: b.id });
    await OverdueSnapshotModel.updateOne({ businessDate: date, branchId: b.id }, { $set: { ...live, takenAt: ctx().clock.now() } }, { upsert: true });
  }
  return branches.length;
}

export const reconciliationQuery = z.object({ branchId: z.string().max(64).optional(), date: z.string().max(10) });

/**
 * FR-COL-014: FOS collections of one business date against the field payments the ERP reported for it.
 * The ERP side is the cached copy from the last sync, so the answer carries `erpFetchedAt` (the oldest
 * copy used); "missing in ERP" right after posting usually means the cache has not been refreshed yet.
 */
export async function reconciliation(user: AuthUser, q: z.infer<typeof reconciliationQuery>) {
  if (!validRange(q.date, q.date, today(), 0)) throw bad('date', 'today or earlier (YYYY-MM-DD)');
  const branchId = branchInScope(user, q.branchId);
  const fos = await collectionRows(user, branchId, q.date, q.date);
  const erp = await erpFieldPayments({ ...customerScope(user), ...(branchId ? branchQuery(user, branchId) : {}) }, q.date);
  const r = reconcileDay(fos, erp);
  const byId = new Map(fos.map((c) => [c.id, c]));
  const erpById = new Map(erp.map((p) => [p.erpPaymentId, p]));
  const customers = await getCustomerRefs([...fos.map((c) => c.customerId), ...erp.map((p) => p.customerId)]);
  const users = await getUsers(fos.map((c) => c.collectorId));
  const fetched = erp.map((p) => p.erpFetchedAt.getTime());
  return {
    date: q.date,
    balanced: r.balanced,
    totals: r.totals,
    erpFetchedAt: fetched.length ? new Date(Math.min(...fetched)).toISOString() : null,
    mismatches: r.mismatches.map((m) => {
      const c = m.collectionId ? byId.get(m.collectionId) : undefined;
      const cust = customers.get(c?.customerId ?? erpById.get(m.erpPaymentId ?? '')?.customerId ?? '');
      const u = c ? users.get(c.collectorId) : undefined;
      return { ...m, customer: cust ? { id: cust.id, name: cust.name.bn || cust.name.en, code: cust.code } : null, collector: u ? { id: u.id, name: u.name.en || u.name.bn } : null };
    }),
  };
}
