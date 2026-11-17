import { z } from 'zod';
import { ctx } from '../../core/context/index.js';
import { AppError, forbidden, notFound } from '../../core/errors/index.js';
import { decodeCursor, encodeCursor } from '../../core/http/index.js';
import { businessDate } from '../../core/time/index.js';
import { branchQuery, type AuthUser } from '../../core/security/types.js';
import { can } from '../rbac/index.js';
import { flagsFor } from '../flags/index.js';
import { getSetting } from '../settings/index.js';
import { getUsers } from '../users/index.js';
import { getBranches } from '../branches/index.js';
import { QUALITY_ISSUES, dataQualityScan, scopeFilter as customerScope, type QualityRow } from '../customers/index.js';
import { collectedByDay, postedSplitOf } from '../collections/index.js';
import { visitSplitByDay } from '../visits/index.js';
import { visitCreditFor } from '../cowork/index.js';
import { targetsOf } from '../targets/index.js';
import { monthEnd, reportRange } from './domain/period.js';
import { rank } from './domain/leaderboard.js';
import { branchInScope, staffPerformance } from './trends.js';

const today = () => businessDate(ctx().clock.now());
const bad = (path: string, message: string) => new AppError('VALIDATION_FAILED', { fields: [{ path, message }] });

// ---------------- leaderboard (FR-REP-005) ----------------

export const METRICS = ['collected', 'visit_credit', 'promises_kept', 'target_achievement'] as const;
type Metric = (typeof METRICS)[number];
export const leaderboardQuery = z.object({ branchId: z.string().max(64).optional(), period: z.enum(['day', 'month']), date: z.string().max(10).optional(), metric: z.enum(METRICS).default('collected') });

/**
 * Field staff read the board with a branch-wide view of the figures. Their own scope only covers
 * their own collections and visits, so the board is computed as a viewer of that one branch.
 */
const branchReader = (user: AuthUser, branchId: string): AuthUser => ({ ...user, role: 'viewer', branchIds: [branchId] });

async function boardAccess(user: AuthUser, requested: string | undefined): Promise<{ reader: AuthUser; branchId: string | undefined }> {
  if (await can(user, 'report.view')) return { reader: user, branchId: branchInScope(user, requested) };
  const own = user.branchIds[0];
  // OD-15: off by default; staff only ever see their own branch.
  if (user.role !== 'field_staff' || !own || !(await getSetting<boolean>('reports.leaderboardVisibleToStaff', own))) throw forbidden('report.view');
  if (requested && requested !== own) throw notFound('branch');
  return { reader: branchReader(user, own), branchId: own };
}

type PerfRow = Awaited<ReturnType<typeof staffPerformance>>[number];
const totalOf = (r: PerfRow) => Object.values(r.collectedPoisha).reduce((a, b) => a + b, 0);
const valueOf = (r: PerfRow, m: Metric): number | null =>
  m === 'collected' ? totalOf(r) : m === 'visit_credit' ? r.visitCredit : m === 'promises_kept' ? r.promisesKept : r.amountAchievement;

async function board(user: AuthUser, reader: AuthUser, branchId: string | undefined, period: 'day' | 'month', date: string, metric: Metric) {
  const rows = await staffPerformance(reader, { period: period === 'day' ? 'daily' : 'monthly', date, branchId });
  const min = (await getSetting<number>('reports.leaderboardMinPresentDays', branchId)) ?? 1;
  // Without attendance there is no presence to check, so everyone may be ranked.
  const attendanceOn = (await flagsFor(user))['module.attendance'];
  const ranked = rank(
    rows.map((r) => ({
      userId: r.userId,
      name: r.name,
      employeeCode: '',
      value: valueOf(r, metric),
      collectedPoisha: totalOf(r),
      visitCredit: r.visitCredit,
      promisesKept: r.promisesKept,
      amountAchievement: r.amountAchievement,
      presentDays: r.presentDays,
      eligible: !attendanceOn || r.presentDays >= min,
      me: r.userId === user.id,
    })),
  );
  const codes = await getUsers(ranked.map((r) => r.userId));
  const items = ranked.map((r) => ({ ...r, employeeCode: codes.get(r.userId)?.employeeCode ?? '' }));
  const mine = items.find((r) => r.me);
  return { items, min, me: mine ? { rank: mine.rank, of: items.filter((r) => r.rank !== null).length } : null };
}

export async function leaderboard(user: AuthUser, q: z.infer<typeof leaderboardQuery>) {
  const t = today();
  const date = q.date ?? (q.period === 'day' ? t : t.slice(0, 7));
  if (!reportRange(q.period === 'day' ? 'daily' : 'monthly', date, t)) throw bad('date', q.period === 'day' ? 'today or earlier (YYYY-MM-DD)' : 'this month or earlier (YYYY-MM)');
  const { reader, branchId } = await boardAccess(user, q.branchId);
  const b = await board(user, reader, branchId, q.period, date, q.metric);
  return { branchId: branchId ?? null, period: q.period, date, metric: q.metric, minPresentDays: b.min, items: b.items, me: b.me };
}

// ---------------- own performance (FR-REP-005, FR-M-021) ----------------

export const mineQuery = z.object({ month: z.string().max(7) });

export async function myPerformance(user: AuthUser, q: z.infer<typeof mineQuery>) {
  const t = today();
  const range = reportRange('monthly', q.month, t);
  if (!range) throw bad('month', 'this month or earlier (YYYY-MM)');
  // The caller's own scope already limits every figure to their own work.
  const [row] = await staffPerformance(user, { period: 'monthly', date: q.month, userId: user.id });
  if (!row) throw notFound('user');
  const on = await flagsFor(user);
  const end = monthEnd(q.month);
  const split = on['module.collections'] ? await postedSplitOf(user.id, range.from, range.to) : { postedPoisha: 0, pendingPoisha: 0 };
  const perDayMoney = on['module.collections'] ? await collectedByDay(user, undefined, range.from, range.to) : new Map<string, { totalPoisha: number; count: number }>();
  const perDayVisits = on['module.visits'] ? await visitSplitByDay(user.id, range.from, range.to) : new Map<string, { recorded: number; solo: number; coWork: number }>();
  const me = (await getUsers([user.id])).get(user.id);
  const targets = on['module.targets'] && me ? ((await targetsOf([me], range.from, end)).get(user.id) ?? null) : null;
  const days = [];
  for (const [date, tg] of targets?.perDay ?? new Map<string, { amountPoisha: number; visits: number; workingDay: boolean }>()) {
    if (date > range.to) break;
    const v = perDayVisits.get(date) ?? { recorded: 0, solo: 0, coWork: 0 };
    days.push({
      date,
      collectedPoisha: perDayMoney.get(date)?.totalPoisha ?? 0,
      collectionsCount: perDayMoney.get(date)?.count ?? 0,
      visits: v.recorded,
      soloVisits: v.solo,
      coWorkVisits: v.coWork,
      visitCredit: await visitCreditFor(v.solo, v.coWork, user.branchIds[0]),
      targetPoisha: tg.amountPoisha,
      visitTarget: tg.visits,
      workingDay: tg.workingDay,
    });
  }
  // Without the targets module there is no day calendar to walk; list the days that have work.
  if (!targets)
    for (const date of [...new Set([...perDayMoney.keys(), ...perDayVisits.keys()])].sort()) {
      const v = perDayVisits.get(date) ?? { recorded: 0, solo: 0, coWork: 0 };
      days.push({ date, collectedPoisha: perDayMoney.get(date)?.totalPoisha ?? 0, collectionsCount: perDayMoney.get(date)?.count ?? 0, visits: v.recorded, soloVisits: v.solo, coWorkVisits: v.coWork, visitCredit: await visitCreditFor(v.solo, v.coWork, user.branchIds[0]), targetPoisha: 0, visitTarget: 0, workingDay: true });
    }
  let rankInfo: { metric: string; rank: number | null; of: number } | null = null;
  const own = user.branchIds[0];
  if (own && (await getSetting<boolean>('reports.leaderboardVisibleToStaff', own))) {
    const b = await board(user, branchReader(user, own), own, 'month', q.month, 'collected');
    rankInfo = { metric: 'collected', rank: b.me?.rank ?? null, of: b.me?.of ?? 0 };
  }
  return { month: q.month, row, collectedTotalPoisha: totalOf(row), ...split, days, rank: rankInfo };
}

// ---------------- data quality (FR-CUS-009) ----------------

export const qualityQuery = z.object({ branchId: z.string().max(64).optional() });
export const qualityItemsQuery = z.object({ branchId: z.string().max(64).optional(), issue: z.enum(QUALITY_ISSUES), limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(200).optional() });

const maxKmOf = async (branchId?: string) => (await getSetting<number>('reports.dataQualityMaxBranchKm', branchId)) ?? 30;

async function scan(user: AuthUser, branchId: string | undefined) {
  return dataQualityScan({ ...customerScope(user), ...branchQuery(user, branchId) }, maxKmOf);
}

export async function dataQuality(user: AuthUser, q: z.infer<typeof qualityQuery>) {
  const branchId = branchInScope(user, q.branchId);
  const rows = await scan(user, branchId);
  const per = new Map<string, { customers: number; withIssues: number; issues: Record<string, number> }>();
  for (const r of rows) {
    const b = per.get(r.branchId) ?? { customers: 0, withIssues: 0, issues: Object.fromEntries(QUALITY_ISSUES.map((i) => [i, 0])) };
    b.customers++;
    if (r.findings.length) b.withIssues++;
    for (const f of r.findings) b.issues[f.issue]!++;
    per.set(r.branchId, b);
  }
  const names = await getBranches([...per.keys()]);
  const branches = [];
  for (const [id, b] of per) branches.push({ branchId: id, branchName: names.get(id)?.name ?? { bn: '', en: '' }, maxBranchKm: await maxKmOf(id), ...b });
  branches.sort((a, b) => (names.get(a.branchId)?.code ?? '').localeCompare(names.get(b.branchId)?.code ?? ''));
  return { generatedAt: ctx().clock.now().toISOString(), maxBranchKm: await maxKmOf(), branches };
}

async function itemViews(rows: QualityRow[], issue: string) {
  const users = await getUsers(rows.map((r) => r.assigneeId).filter((x): x is string => !!x));
  return rows.map((r) => {
    const a = r.assigneeId ? users.get(r.assigneeId) : undefined;
    return {
      customerId: r.customerId,
      code: r.code,
      name: r.name,
      branchId: r.branchId,
      areaCode: r.areaCode,
      assignee: r.assigneeId ? { id: r.assigneeId, name: a ? a.name.en || a.name.bn : '' } : null,
      issue,
      detail: r.findings.find((f) => f.issue === issue)?.detail ?? '',
      issues: r.findings.map((f) => f.issue),
    };
  });
}

export async function dataQualityItems(user: AuthUser, q: z.infer<typeof qualityItemsQuery>) {
  const branchId = branchInScope(user, q.branchId);
  const rows = await scan(user, branchId);
  const cur = decodeCursor<{ id: string }>(q.cursor);
  const hits = rows.filter((r) => r.findings.some((f) => f.issue === q.issue) && (!cur || r.customerId > cur.id));
  const page = hits.slice(0, q.limit);
  return { items: await itemViews(page, q.issue), nextCursor: hits.length > q.limit ? encodeCursor({ id: page[page.length - 1]!.customerId }) : null };
}

/** Rows for the data_quality export: one line per customer and issue. */
export async function dataQualityExportRows(user: AuthUser, branchId: string | undefined, issue?: string) {
  const rows = await scan(user, branchInScope(user, branchId));
  const out: Awaited<ReturnType<typeof itemViews>> = [];
  for (const i of QUALITY_ISSUES) {
    if (issue && issue !== i) continue;
    out.push(...(await itemViews(rows.filter((r) => r.findings.some((f) => f.issue === i)), i)));
  }
  return out;
}
