import { addDays } from '../../core/time/index.js';
import { branchQuery, type AuthUser } from '../../core/security/types.js';
import { getUsers } from '../users/index.js';
import { payStateCounts, pendingProposalCount, scopeFilter as customerScope } from '../customers/index.js';
import { collectedByUser, collectionDayCells, type CollectionDayCell } from '../collections/index.js';
import { visitDashboardStats, visitsByUser } from '../visits/index.js';
import { promiseDashboardStats } from '../promises/index.js';
import { coworkSessionCount } from '../cowork/index.js';
import { prospectDashboardStats } from '../prospects/index.js';
import { datesOf, linkTo, monthStart, previousMonth, rate, topBy, type DashboardLink, type DashboardRange } from './domain/dashboard.js';

const TOP = 5;

interface Amount {
  amountPoisha: number;
  count: number;
  link: DashboardLink;
}
interface Count {
  count: number;
  link: DashboardLink;
}

/** What the overview already computed and the new blocks reuse, so both always show the same figures. */
export interface DashboardInputs {
  today: string;
  range: DashboardRange;
  branchId: string | undefined;
  on: Record<string, boolean>;
  overdue: { customers: number; amountPoisha: number };
  attendance: { present: number; late: number; absent: number; onLeave: number; onDutyNow: number } | null;
  cash: { onHandPoisha: number; holders: number } | null;
}

/**
 * FR-DSH-002 statistics blocks. Each figure is aggregated in the module that owns the data, in the caller's scope
 * (field staff: their own), and carries the list link (path + query that list accepts) behind it.
 */
export async function dashboardStats(user: AuthUser, x: DashboardInputs) {
  const { today, branchId, on } = x;
  const { from, to } = x.range;
  const own = user.role === 'field_staff';
  // Filters every link carries: the branch asked for, and for field staff their own rows.
  const b = branchId ? { branchId } : {};
  const mine = (param: string) => (own ? { [param]: user.id } : {});
  const prev = previousMonth(today);
  const thisMonth = { from: monthStart(today), to: today };

  // ---- collections: one aggregation over [min(range, previous month), today] ----
  const cells: CollectionDayCell[] = on['module.collections'] ? await collectionDayCells(user, branchId, from < prev.from ? from : prev.from, today) : [];
  const colLink = (q: Record<string, string>) => linkTo('/collections', { ...b, ...mine('collectorId'), ...q });
  const sum = (pick: (c: CollectionDayCell) => boolean, q: Record<string, string>): Amount => {
    const rows = cells.filter(pick);
    return { amountPoisha: rows.reduce((t, c) => t + c.amountPoisha, 0), count: rows.reduce((t, c) => t + c.count, 0), link: colLink(q) };
  };
  const inR = (c: CollectionDayCell) => c.date >= from && c.date <= to;
  const methods = [...new Set(cells.filter(inR).map((c) => c.method))];
  const collections = {
    today: sum((c) => c.date === today, { from: today, to: today }),
    thisMonth: sum((c) => c.date >= thisMonth.from && c.date <= thisMonth.to, thisMonth),
    previousMonth: sum((c) => c.date >= prev.from && c.date <= prev.to, prev),
    inRange: sum(inR, { from, to }),
    series: datesOf(from, to).map((d) => {
      const s = sum((c) => c.date === d, {});
      return { date: d, amountPoisha: s.amountPoisha, count: s.count };
    }),
    byMethod: topBy(
      methods.map((m) => ({ method: m, ...sum((c) => inR(c) && c.method === m, { from, to, method: m }) })),
      (r) => r.amountPoisha,
      (r) => r.method,
      methods.length,
    ),
    // GET /collections filters one status; `posted` is nearly all of it (resolved_posted is the rare rest).
    erpPosted: sum((c) => inR(c) && c.erp === 'posted', { from, to, status: 'posted' }),
    // The list cannot filter "not yet in the ERP" (four statuses); the link opens the range.
    pendingInField: sum((c) => inR(c) && c.erp === 'pending', { from, to }),
  };

  // ---- visits ----
  const vs = on['module.visits'] ? await visitDashboardStats(user, branchId, from, to) : { total: 0, uniqueCustomers: 0, byDay: new Map<string, number>(), byOutcome: new Map<string, number>() };
  const visitLink = (q: Record<string, string>) => linkTo('/visits', { ...b, ...mine('userId'), from, to, ...q });
  const visitStats = {
    total: { count: vs.total, link: visitLink({}) },
    uniqueCustomers: vs.uniqueCustomers,
    series: datesOf(from, to).map((d) => ({ date: d, count: vs.byDay.get(d) ?? 0 })),
    byOutcome: topBy([...vs.byOutcome.entries()], ([, n]) => n, ([o]) => o, vs.byOutcome.size).map(([outcome, n]) => ({ outcome, count: n, link: visitLink({ outcome }) })),
  };

  // ---- promises ----
  const ps = on['module.promises']
    ? await promiseDashboardStats(user, branchId, today, from, to)
    : { dueToday: { amountPoisha: 0, count: 0 }, next7Days: { amountPoisha: 0, count: 0 }, next15Days: { amountPoisha: 0, count: 0 }, kept: 0, partiallyKept: 0, broken: 0, brokenWithoutFollowUp: 0 };
  const prLink = (q: Record<string, string>) => linkTo('/promises', { ...b, ...mine('ownerId'), ...q });
  const decided = ps.kept + ps.partiallyKept + ps.broken;
  const promiseStats = {
    dueToday: { ...ps.dueToday, link: prLink({ from: today, to: today, status: 'open' }) },
    next7Days: { ...ps.next7Days, link: prLink({ from: today, to: addDays(today, 7), status: 'open' }) },
    next15Days: { ...ps.next15Days, link: prLink({ from: today, to: addDays(today, 15), status: 'open' }) },
    kept: { count: ps.kept, link: prLink({ from, to, status: 'kept' }) },
    partiallyKept: { count: ps.partiallyKept, link: prLink({ from, to, status: 'partially_kept' }) },
    broken: { count: ps.broken, link: prLink({ from, to, status: 'broken' }) },
    keptRate: rate(ps.kept, decided),
    brokenRate: rate(ps.broken, decided),
    brokenWithoutFollowUp: { count: ps.brokenWithoutFollowUp, link: prLink({ from, to, brokenWithoutFollowUp: 'true' }) },
  };

  // ---- customers ----
  const custLink = (q: Record<string, string>) => linkTo('/customers', { ...b, ...q });
  const overdueCustomers: Amount = { amountPoisha: x.overdue.amountPoisha, count: x.overdue.customers, link: custLink({ filter: 'overdue' }) };
  const custOn = on['module.customers'] === true;
  const payStates = custOn ? (await payStateCounts({ ...(await customerScope(user)), ...(branchId ? branchQuery(user, branchId) : {}) })).map((p) => ({ ...p, link: custLink({ payState: p.payState }) })) : [];
  const pinApprovals: Count = { count: custOn ? await pendingProposalCount(user, branchId) : 0, link: linkTo('/location-proposals', { ...b, status: 'pending' }) };

  // ---- top staff ----
  const [byCol, byVis] = await Promise.all([
    on['module.collections'] ? collectedByUser(user, branchId, from, to) : new Map<string, { count: number; byMethod: Record<string, number> }>(),
    on['module.visits'] ? visitsByUser(user, branchId, from, to) : new Map<string, { count: number; uniqueCustomers: number }>(),
  ]);
  const colTop = topBy(
    [...byCol.entries()].map(([userId, r]) => ({ userId, amountPoisha: Object.values(r.byMethod).reduce((t, v) => t + v, 0), count: r.count })),
    (r) => r.amountPoisha,
    (r) => r.userId,
    TOP,
  );
  const visTop = topBy([...byVis.entries()].map(([userId, r]) => ({ userId, count: r.count })), (r) => r.count, (r) => r.userId, TOP);
  const people = await getUsers([...colTop, ...visTop].map((r) => r.userId));
  const nameOf = (id: string) => {
    const u = people.get(id);
    return u ? u.name.en || u.name.bn || '' : '';
  };
  const topStaff = {
    byCollection: colTop.map((r) => ({ ...r, name: nameOf(r.userId), link: linkTo('/collections', { ...b, from, to, collectorId: r.userId }) })),
    byVisits: visTop.map((r) => ({ ...r, name: nameOf(r.userId), link: linkTo('/visits', { ...b, from, to, userId: r.userId }) })),
  };

  // ---- now-figures ----
  const att = x.attendance ?? { present: 0, late: 0, absent: 0, onLeave: 0, onDutyNow: 0 };
  const attLink = linkTo('/attendance/days', { ...b, ...mine('userId'), from: today, to: today });
  const attendanceToday = {
    present: { count: att.present, link: attLink },
    late: { count: att.late, link: attLink },
    absent: { count: att.absent, link: attLink },
    onLeave: { count: att.onLeave, link: attLink },
    onDutyNow: { count: att.onDutyNow, link: attLink },
  };
  const cashInHand: Amount = { amountPoisha: x.cash?.onHandPoisha ?? 0, count: x.cash?.holders ?? 0, link: linkTo('/cash/positions', { ...b }) };

  const coworkStats = {
    sessions: { count: on['module.cowork'] ? await coworkSessionCount(user, branchId, from, to) : 0, link: linkTo('/cowork/sessions', { ...b, ...mine('userId'), from, to }) },
  };

  // Possible customers (FR-PRO-001): created and converted in range, open (new or contacted) now. GET /prospects filters
  // from/to on the creation date and one status, so the `converted` and `openNow` links are the nearest lists.
  const proLink = (q: Record<string, string>) => linkTo('/prospects', { ...b, ...mine('createdBy'), ...q });
  const pro = on['module.prospects'] ? await prospectDashboardStats(user, branchId, from, to) : { created: 0, converted: 0, openNow: 0 };
  const prospectStats = {
    created: { count: pro.created, link: proLink({ from, to }) },
    converted: { count: pro.converted, link: proLink({ status: 'converted' }) },
    openNow: { count: pro.openNow, link: proLink({}) },
  };

  return {
    range: x.range,
    collections,
    visitStats,
    promiseStats,
    overdueCustomers,
    payStates,
    topStaff,
    attendanceToday,
    pinApprovals,
    cashInHand,
    coworkStats,
    prospectStats,
  };
}
