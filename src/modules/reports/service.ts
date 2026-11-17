import { ctx } from '../../core/context/index.js';
import { AppError } from '../../core/errors/index.js';
import { addDays, businessDate, isIsoDate } from '../../core/time/index.js';
import { branchQuery, canSeeBranch, type AuthUser } from '../../core/security/types.js';
import { flagsFor } from '../flags/index.js';
import { erpStatus } from '../erp-gateway/index.js';
import { overdueSummary, scopeFilter as customerScope } from '../customers/index.js';
import { collectedByDay } from '../collections/index.js';
import { visitsByDay } from '../visits/index.js';
import { promiseDayCounts } from '../promises/index.js';
import { attendanceCounts } from '../attendance/index.js';
import { cashOverview } from '../cash/index.js';
import { inboxOpenCounts } from '../inbox/index.js';
import { teamDay } from './trends.js';

const ZERO = { totalPoisha: 0, cashPoisha: 0, mobilePoisha: 0, count: 0 };

/**
 * FR-DSH-001 overview. Every number is FOS activity or a cached ERP value; nothing here is an
 * "official" balance (CLAUDE.md §2.1). Sections of switched-off modules come back as zeros.
 */
export async function overview(user: AuthUser, q: { branchId?: string | undefined; date?: string | undefined }) {
  const today = businessDate(ctx().clock.now());
  const date = q.date ?? today;
  if (!isIsoDate(date) || date > today) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'date', message: 'today or earlier (YYYY-MM-DD)' }] });
  // A branch outside the caller's scope yields an empty dashboard rather than leaking that it exists.
  const branchId = q.branchId && canSeeBranch(user, q.branchId) ? q.branchId : undefined;
  if (q.branchId && !branchId) throw new AppError('NOT_FOUND', { entity: 'branch' });
  const on = await flagsFor(user);
  const from = addDays(date, -6);

  const collected = on['module.collections'] ? await collectedByDay(user, branchId, from, date) : new Map<string, typeof ZERO>();
  const visits = on['module.visits'] ? await visitsByDay(user, branchId, from, date) : new Map<string, { count: number; uniqueCustomers: number }>();
  const team = await teamDay(user, branchId, date, on);
  const trend7d = [];
  for (let d = from; d <= date; d = addDays(d, 1)) trend7d.push({ date: d, collectedPoisha: collected.get(d)?.totalPoisha ?? 0, visits: visits.get(d)?.count ?? 0 });

  return {
    date,
    collected: { ...(collected.get(date) ?? ZERO), targetPoisha: team.targetPoisha },
    visits: { ...(visits.get(date) ?? { count: 0, uniqueCustomers: 0 }), credit: team.visitCredit, target: team.visitTarget },
    promises: on['module.promises'] ? await promiseDayCounts(user, branchId, date) : { dueToday: 0, keptToday: 0, brokenYesterday: 0 },
    // Attendance and cash are "now" figures; they are only meaningful for today.
    attendance: on['module.attendance'] && date === today ? await attendanceCounts(user, branchId) : { present: 0, late: 0, absent: 0, onDutyNow: 0 },
    cash: on['module.cash'] ? await cashOverview(user, branchId) : { onHandPoisha: 0, overLimitStaff: 0, pendingDeposits: 0 },
    exceptions: on['module.inbox'] ? await inboxOpenCounts(user, branchId) : {},
    overdue: await overdueSummary({ ...customerScope(user), ...(branchId ? branchQuery(user, branchId) : {}) }),
    erp: await erpStatus(),
    trend7d,
  };
}
