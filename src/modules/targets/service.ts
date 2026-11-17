import { z } from 'zod';
import { ctx } from '../../core/context/index.js';
import { businessRule, notFound } from '../../core/errors/index.js';
import { isOid, withTransaction, type LeanDoc } from '../../core/db/index.js';
import { addDays, businessDate, isIsoDate } from '../../core/time/index.js';
import { canSeeBranch, type AuthUser } from '../../core/security/types.js';
import type { RequestMeta } from '../../core/http/router.js';
import * as audit from '../audit/index.js';
import { getUser, getUsers, listStaff, type UserView } from '../users/index.js';
import { getBranch } from '../branches/index.js';
import { dayKindsOf } from '../attendance/index.js';
import { effective, round2, type Effective, type TargetRecord } from './domain/resolve.js';
import { TargetModel } from './models/target.model.js';

type Lean = LeanDoc;
const day = z.string().refine(isIsoDate, 'YYYY-MM-DD');
const reason = z.string().trim().min(3).max(300);
export const valueSchema = z.object({ amountPoisha: z.number().int().min(0).max(100_000_000_00), visits: z.number().min(0).max(100), effectiveFrom: day.optional(), reason });
export const clearSchema = z.object({ effectiveFrom: day.optional(), reason });
export const listQuery = z.object({ branchId: z.string().max(64).optional(), date: day.optional() });
export const meQuery = z.object({ date: day.optional() });

const today = () => businessDate(ctx().clock.now());
const toRecord = (r: Lean): TargetRecord => ({ id: r._id.toHexString(), userId: r.userId ?? null, kind: r.kind, amountPoisha: r.amountPoisha ?? null, visits: r.visits ?? null, effectiveFrom: r.effectiveFrom, setAt: r.setAt });

/** Branch defaults and personal records of these people, every date; the rules pick per day. */
async function recordsOf(branchIds: string[], userIds: string[]) {
  const rows = (await TargetModel.find({ branchId: { $in: branchIds }, $or: [{ userId: null }, { userId: { $in: userIds } }] }).lean()) as Lean[];
  const byRecord = new Map(rows.map((r) => [r._id.toHexString() as string, r]));
  const branch = new Map<string, TargetRecord[]>();
  const personal = new Map<string, TargetRecord[]>();
  for (const r of rows) {
    const rec = toRecord(r);
    if (rec.userId === null) branch.set(r.branchId, [...(branch.get(r.branchId) ?? []), rec]);
    else personal.set(rec.userId, [...(personal.get(rec.userId) ?? []), rec]);
  }
  return { branch, personal, byRecord };
}

async function valueView(e: Effective, raw: Map<string, Lean>) {
  const r = e.record ? raw.get(e.record.id) : undefined;
  const by = r ? await getUser(r.setBy) : null;
  return {
    amountPoisha: e.amountPoisha,
    visits: e.visits,
    effectiveFrom: r ? (r.effectiveFrom as string) : null,
    reason: r ? (r.reason as string) : null,
    setBy: r ? { id: r.setBy as string, name: by ? by.name.en || by.name.bn : '' } : null,
    setAt: r ? (r.setAt as Date).toISOString() : null,
  };
}

const person = (u: UserView) => ({ id: u.id, shiftId: u.shiftId, branchId: u.branchIds[0] ?? null });

/** One person on one date, as GET /targets and the app show it. */
async function rowOf(u: UserView, date: string) {
  const branchId = u.branchIds[0] ?? '';
  const { branch, personal, byRecord } = await recordsOf([branchId], [u.id]);
  const kind = (await dayKindsOf([person(u)], date, date)).get(u.id)?.get(date) ?? 'working';
  const e = effective(personal.get(u.id) ?? [], branch.get(branchId) ?? [], date);
  const working = kind === 'working';
  const v = await valueView(e, byRecord);
  return { ...v, amountPoisha: working ? e.amountPoisha : 0, visits: working ? e.visits : 0, userId: u.id, name: u.name.en || u.name.bn, employeeCode: u.employeeCode, source: e.source, workingDay: working };
}

function branchOf(user: AuthUser, requested: string | undefined): string {
  const id = requested ?? user.branchIds[0];
  if (!id || !isOid(id) || !canSeeBranch(user, id)) throw notFound('branch');
  return id;
}

/** FR-COL-015: what applies to whom on a date, and where each value comes from. */
export async function list(user: AuthUser, q: z.infer<typeof listQuery>) {
  const branchId = branchOf(user, q.branchId);
  const date = q.date ?? today();
  const staff = await listStaff(branchId);
  const { branch, personal, byRecord } = await recordsOf([branchId], staff.map((s) => s.id));
  const kinds = await dayKindsOf(staff.map(person), date, date);
  const items = [];
  for (const u of staff) {
    const e = effective(personal.get(u.id) ?? [], branch.get(branchId) ?? [], date);
    const working = kinds.get(u.id)?.get(date) === 'working';
    const v = await valueView(e, byRecord);
    items.push({ ...v, amountPoisha: working ? e.amountPoisha : 0, visits: working ? e.visits : 0, userId: u.id, name: u.name.en || u.name.bn, employeeCode: u.employeeCode, source: e.source, workingDay: working });
  }
  const d = effective([], branch.get(branchId) ?? [], date);
  return { branchId, date, defaults: await valueView(d, byRecord), items };
}

async function staffInScope(user: AuthUser, id: string): Promise<UserView> {
  const u = isOid(id) ? await getUser(id) : null;
  if (!u || !u.active || u.role !== 'field_staff' || !u.branchIds.some((b) => canSeeBranch(user, b))) throw notFound('user');
  return u;
}

function startDate(input?: string): string {
  const t = today();
  const from = input ?? t;
  // Past days keep the target they had, so a report of last week never changes afterwards.
  if (from < t) throw businessRule('TARGET_IN_PAST', { today: t });
  return from;
}

async function write(user: AuthUser, doc: Record<string, unknown>, action: string, meta: RequestMeta) {
  return withTransaction(async (session) => {
    const [r] = await TargetModel.create([{ ...doc, setBy: user.id, setAt: ctx().clock.now() }], { session });
    const id = r!._id.toHexString();
    await audit.record({ actor: user, action, entity: 'target', entityId: id, branchId: doc.branchId as string, after: doc, reason: doc.reason as string, meta }, session);
    return id;
  });
}

export async function setUser(user: AuthUser, id: string, input: z.infer<typeof valueSchema>, meta: RequestMeta) {
  const u = await staffInScope(user, id);
  const from = startDate(input.effectiveFrom);
  await write(user, { branchId: u.branchIds[0], userId: u.id, kind: 'set', amountPoisha: input.amountPoisha, visits: input.visits, effectiveFrom: from, reason: input.reason }, 'target.set', meta);
  return rowOf(u, from);
}

export async function clearUser(user: AuthUser, id: string, input: z.infer<typeof clearSchema>, meta: RequestMeta) {
  const u = await staffInScope(user, id);
  const from = startDate(input.effectiveFrom);
  await write(user, { branchId: u.branchIds[0], userId: u.id, kind: 'cleared', amountPoisha: null, visits: null, effectiveFrom: from, reason: input.reason }, 'target.cleared', meta);
  return rowOf(u, from);
}

export async function setBranch(user: AuthUser, branchId: string, input: z.infer<typeof valueSchema>, meta: RequestMeta) {
  if (!isOid(branchId) || !canSeeBranch(user, branchId) || !(await getBranch(branchId))) throw notFound('branch');
  const from = startDate(input.effectiveFrom);
  const id = await write(user, { branchId, userId: null, kind: 'set', amountPoisha: input.amountPoisha, visits: input.visits, effectiveFrom: from, reason: input.reason }, 'target.branch_set', meta);
  const r = (await TargetModel.findById(id).lean()) as Lean;
  return valueView({ amountPoisha: input.amountPoisha, visits: input.visits, source: 'branch', record: toRecord(r) }, new Map([[id, r]]));
}

export async function history(user: AuthUser, id: string) {
  const u = await staffInScope(user, id);
  const rows = (await TargetModel.find({ userId: u.id }).sort({ setAt: -1, _id: -1 }).limit(200).lean()) as Lean[];
  const by = await getUsers(rows.map((r) => r.setBy));
  return rows.map((r) => {
    const b = by.get(r.setBy);
    return { id: r._id.toHexString(), userId: r.userId, branchId: r.branchId, kind: r.kind, amountPoisha: r.amountPoisha ?? null, visits: r.visits ?? null, effectiveFrom: r.effectiveFrom, reason: r.reason, setBy: { id: r.setBy, name: b ? b.name.en || b.name.bn : '' }, setAt: (r.setAt as Date).toISOString() };
  });
}

/** The caller's own target (GET /targets/me, sync envelope). */
export async function mine(user: AuthUser, date?: string) {
  const u = await getUser(user.id);
  if (!u) throw notFound('user');
  const d = date ?? today();
  const r = await rowOf(u, d);
  return { businessDate: d, amountPoisha: r.amountPoisha, visits: r.visits, source: r.source, workingDay: r.workingDay };
}

export interface TargetTotals {
  amountPoisha: number;
  visits: number;
  amountToDatePoisha: number;
  visitsToDate: number;
  days: number;
  perDay: Map<string, { amountPoisha: number; visits: number; workingDay: boolean }>;
}

/**
 * FR-COL-015 for reports: each person's targets summed over the working days of from..to, and
 * up to today for a period that is still running.
 */
export async function targetsOf(people: UserView[], from: string, to: string): Promise<Map<string, TargetTotals>> {
  const out = new Map<string, TargetTotals>();
  if (!people.length) return out;
  const branchIds = [...new Set(people.map((p) => p.branchIds[0] ?? ''))];
  const { branch, personal } = await recordsOf(branchIds, people.map((p) => p.id));
  const kinds = await dayKindsOf(people.map(person), from, to);
  const t = today();
  for (const p of people) {
    const tot: TargetTotals = { amountPoisha: 0, visits: 0, amountToDatePoisha: 0, visitsToDate: 0, days: 0, perDay: new Map() };
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const working = kinds.get(p.id)?.get(d) === 'working';
      const e = effective(personal.get(p.id) ?? [], branch.get(p.branchIds[0] ?? '') ?? [], d);
      const a = working ? e.amountPoisha : 0;
      const v = working ? e.visits : 0;
      tot.perDay.set(d, { amountPoisha: a, visits: v, workingDay: working });
      tot.amountPoisha += a;
      tot.visits += v;
      if (d <= t) {
        tot.amountToDatePoisha += a;
        tot.visitsToDate += v;
      }
      if (working && (a > 0 || v > 0)) tot.days++;
    }
    tot.visits = round2(tot.visits);
    tot.visitsToDate = round2(tot.visitsToDate);
    out.set(p.id, tot);
  }
  return out;
}
