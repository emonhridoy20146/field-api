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
import { attendanceDashboardCounts } from '../attendance/index.js';
import { cashDashboard } from '../cash/index.js';
import { inboxOpenCounts } from '../inbox/index.js';
import { teamDay } from './trends.js';
import { dashboardStats } from './dashboard.js';
import { resolveRange } from './domain/dashboard.js';

const ZERO = { totalPoisha: 0, cashPoisha: 0, mobilePoisha: 0, count: 0 };
const bad = (path: string, message: string) => new AppError('VALIDATION_FAILED', { fields: [{ path, message }] });

/**
 * FR-DSH-001 overview, plus the FR-DSH-002 statistics (1.45.0). Every number is FOS activity or a cached ERP value;
 * nothing here is an "official" balance (CLAUDE.md §2.1). Sections of switched-off modules come back as zeros.
 */
export async function overview(user: AuthUser, q: { branchId?: string | undefined; date?: string | undefined; from?: string | undefined; to?: string | undefined }) {
  const today = businessDate(ctx().clock.now());
  const date = q.date ?? today;
  if (!isIsoDate(date) || date > today) throw bad('date', 'today or earlier (YYYY-MM-DD)');
  const range = resolveRange(q, date, today);
  if ('invalid' in range) throw bad(range.invalid, range.message);
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
  // Attendance and cash are "now" figures: read once, shown in the old blocks and the 1.45.0 ones alike.
  const att = on['module.attendance'] ? await attendanceDashboardCounts(user, branchId) : null;
  const cash = on['module.cash'] ? await cashDashboard(user, branchId) : null;
  const overdue = await overdueSummary({ ...(await customerScope(user)), ...(branchId ? branchQuery(user, branchId) : {}) });

  return {
    date,
    collected: { ...(collected.get(date) ?? ZERO), targetPoisha: team.targetPoisha },
    visits: { ...(visits.get(date) ?? { count: 0, uniqueCustomers: 0 }), credit: team.visitCredit, target: team.visitTarget },
    promises: on['module.promises'] ? await promiseDayCounts(user, branchId, date) : { dueToday: 0, keptToday: 0, brokenYesterday: 0 },
    // The old block is only meaningful for today.
    attendance: att && date === today ? { present: att.present, late: att.late, absent: att.absent, onDutyNow: att.onDutyNow } : { present: 0, late: 0, absent: 0, onDutyNow: 0 },
    cash: cash ? { onHandPoisha: cash.onHandPoisha, overLimitStaff: cash.overLimitStaff, pendingDeposits: cash.pendingDeposits } : { onHandPoisha: 0, overLimitStaff: 0, pendingDeposits: 0 },
    exceptions: on['module.inbox'] ? await inboxOpenCounts(user, branchId) : {},
    overdue,
    erp: await erpStatus(),
    trend7d,
    ...(await dashboardStats(user, { today, range, branchId, on, overdue, attendance: att, cash })),
  };
}
