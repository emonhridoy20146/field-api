import { z } from 'zod';
import { ctx } from '../../core/context/index.js';
import { AppError, businessRule, notFound } from '../../core/errors/index.js';
import { isOid, withTransaction, type LeanDoc } from '../../core/db/index.js';
import { businessDate, isIsoDate } from '../../core/time/index.js';
import { branchQuery, canSeeBranch, type AuthUser } from '../../core/security/types.js';
import type { RequestMeta } from '../../core/http/router.js';
import * as audit from '../audit/index.js';
import { can } from '../rbac/index.js';
import { getUser } from '../users/index.js';
import { assignmentStateOfBranch, getCustomerRefs } from '../customers/index.js';
import { areasHeldBy, recomputeBranch, revertTransfer, transfer } from '../assignments/index.js';
import { dueToApply, dueToRevert, EXPIRY_HOURS, REMIND_AFTER_HOURS, transition, type HandoverAction, type HandoverStatus } from './domain/lifecycle.js';
import { HandoverModel } from './models/handover.model.js';

type Lean = LeanDoc;
const today = () => businessDate(ctx().clock.now());

/** Other modules add to the receiver's summary (promises → openPromises, collections → openConflicts, cash → cashOnHandPoisha). */
export type SummaryContributor = (p: { fromUserId: string; customerIds: string[] }) => Promise<Record<string, number>>;
const contributors: SummaryContributor[] = [];
export const registerSummaryContributor = (c: SummaryContributor) => void contributors.push(c);

export const createSchema = z
  .object({
    fromUserId: z.string().max(64),
    toUserId: z.string().max(64),
    areaIds: z.array(z.string().max(64)).max(50).default([]),
    customerIds: z.array(z.string().max(64)).max(5000).default([]),
    reason: z.string().trim().min(5).max(500),
    effectiveDate: z.string().refine(isIsoDate, 'YYYY-MM-DD').optional(),
    endDate: z.string().refine(isIsoDate, 'YYYY-MM-DD').optional(),
  })
  .refine((h) => h.areaIds.length + h.customerIds.length > 0, { message: 'areaIds or customerIds required', path: ['customerIds'] })
  .refine((h) => h.fromUserId !== h.toUserId, { message: 'from and to must differ', path: ['toUserId'] });

function view(h: Lean) {
  return {
    id: h._id.toHexString(),
    fromUserId: h.fromUserId,
    toUserId: h.toUserId,
    areaIds: h.areaIds ?? [],
    customerIds: h.customerIds ?? [],
    reason: h.reason,
    effectiveDate: h.effectiveDate,
    ...(h.endDate ? { endDate: h.endDate } : {}),
    status: h.status as HandoverStatus,
    createdBy: h.createdBy,
    createdAt: (h.createdAt as Date).toISOString(),
    expiresAt: (h.expiresAt as Date).toISOString(),
    summary: h.summary ?? {},
  };
}

async function fieldStaffIn(userId: string, branchId: string | null) {
  const u = isOid(userId) ? await getUser(userId) : null;
  if (!u) throw notFound('user');
  if (!u.active) throw businessRule('USER_INACTIVE');
  if (u.role !== 'field_staff') throw businessRule('NOT_FIELD_STAFF');
  if (branchId && !u.branchIds.includes(branchId)) throw businessRule('USER_NOT_IN_BRANCH');
  return u;
}

/** Customers the handover moves: listed customers + from-user's customers in the listed areas. */
async function affectedCustomers(branchId: string, fromUserId: string, areaIds: string[], customerIds: string[]) {
  const state = await assignmentStateOfBranch(branchId);
  const set = new Set(customerIds);
  for (const c of state) if (c.areaId && areaIds.includes(c.areaId) && c.assigneeId === fromUserId) set.add(c.id);
  return [...set];
}

async function summarize(fromUserId: string, ids: string[]) {
  const refs = await getCustomerRefs(ids);
  const summary: Record<string, number> = { customers: ids.length, outstandingPoisha: 0, overdue: 0, openPromises: 0, openConflicts: 0 };
  for (const r of refs.values()) {
    summary.outstandingPoisha! += r.totalOutstandingPoisha;
    if (r.overdue) summary.overdue!++;
  }
  for (const c of contributors) Object.assign(summary, await c({ fromUserId, customerIds: ids }));
  return summary;
}

export async function create(user: AuthUser, input: z.infer<typeof createSchema>, meta: RequestMeta) {
  const from = await fieldStaffIn(input.fromUserId, null);
  const branchId = from.branchIds.find((b) => canSeeBranch(user, b));
  if (!branchId) throw notFound('user');
  await fieldStaffIn(input.toUserId, branchId); // same branch (ADR: cross-branch moves are a re-assignment, not a handover)
  const held = await areasHeldBy(from.id);
  const badArea = input.areaIds.find((a) => !held.includes(a));
  if (badArea) throw businessRule('AREA_NOT_HELD', { areaId: badArea });
  const refs = await getCustomerRefs(input.customerIds);
  const badCustomer = input.customerIds.find((id) => refs.get(id)?.assigneeId !== from.id);
  if (badCustomer) throw businessRule('CUSTOMER_NOT_HELD', { customerId: badCustomer });
  const effectiveDate = input.effectiveDate ?? today();
  if (effectiveDate < today()) throw businessRule('EFFECTIVE_DATE_PAST');
  if (input.endDate && input.endDate < effectiveDate) throw businessRule('END_BEFORE_EFFECTIVE');
  if (await HandoverModel.exists({ fromUserId: from.id, status: 'pending_acceptance', customerIds: { $in: input.customerIds } }))
    throw new AppError('INVALID_STATE', { reason: 'PENDING_HANDOVER_EXISTS' });
  const ids = await affectedCustomers(branchId, from.id, input.areaIds, input.customerIds);
  const now = ctx().clock.now();
  const h = await HandoverModel.create({
    ...input,
    branchId,
    effectiveDate,
    endDate: input.endDate ?? null,
    createdBy: user.id,
    expiresAt: new Date(now.getTime() + EXPIRY_HOURS * 3_600_000),
    summary: await summarize(from.id, ids),
  });
  await audit.record({ actor: user, action: 'handover.created', entity: 'handover', entityId: h._id.toHexString(), branchId, after: { ...input, effectiveDate }, reason: input.reason, meta });
  await ctx().bus.emit('handover.created', { handoverId: h._id.toHexString(), branchId, fromUserId: from.id, toUserId: input.toUserId });
  return view(h.toObject() as Lean);
}

async function visibleFilter(user: AuthUser): Promise<Record<string, unknown>> {
  if (await can(user, 'handover.create')) return branchQuery(user, undefined);
  return { $or: [{ fromUserId: user.id }, { toUserId: user.id }] };
}

export async function list(user: AuthUser, q: { branchId?: string | undefined; status?: string | undefined; mine?: boolean | undefined }) {
  const and: Record<string, unknown>[] = [await visibleFilter(user)];
  if (q.branchId) and.push(branchQuery(user, q.branchId));
  if (q.status) and.push({ status: q.status });
  if (q.mine) and.push({ $or: [{ fromUserId: user.id }, { toUserId: user.id }] });
  const rows = (await HandoverModel.find({ $and: and }).sort({ createdAt: -1 }).limit(500).lean()) as Lean[];
  return rows.map(view);
}

async function load(user: AuthUser, id: string): Promise<Lean> {
  if (!isOid(id)) throw notFound('handover');
  const h = (await HandoverModel.findOne({ _id: id, ...(await visibleFilter(user)) }).lean()) as Lean | null;
  if (!h) throw notFound('handover');
  return h;
}

export async function get(user: AuthUser, id: string) {
  return view(await load(user, id));
}

async function move(h: Lean, action: HandoverAction, extra: Record<string, unknown> = {}) {
  const to = transition(h.status, action);
  if (!to) throw new AppError('INVALID_STATE', { reason: 'HANDOVER_NOT_PENDING', status: h.status });
  const r = await HandoverModel.updateOne({ _id: h._id, status: h.status }, { $set: { status: to, ...extra } });
  if (r.modifiedCount !== 1) throw new AppError('INVALID_STATE', { reason: 'HANDOVER_CHANGED' });
  return to;
}

/** Apply the assignment transfer (TX) and recompute; idempotent via appliedAt guard. */
async function apply(h: Lean, by: string) {
  const id = h._id.toHexString();
  const now = ctx().clock.now();
  const done = await withTransaction(async (session) => {
    const claim = await HandoverModel.updateOne({ _id: h._id, status: 'accepted', appliedAt: null }, { $set: { appliedAt: now } }, { session });
    if (claim.modifiedCount !== 1) return null;
    const t = await transfer({ branchId: h.branchId, fromUserId: h.fromUserId, toUserId: h.toUserId, areaIds: h.areaIds, customerIds: h.customerIds, source: `handover:${id}`, by }, session);
    await HandoverModel.updateOne({ _id: h._id }, { $set: { transfer: t } }, { session });
    await audit.record({ actor: null, action: 'handover.applied', entity: 'handover', entityId: id, branchId: h.branchId, after: t }, session);
    return t;
  });
  if (!done) return;
  await recomputeBranch(h.branchId);
  const ids = await affectedCustomers(h.branchId, h.toUserId, h.areaIds, h.customerIds);
  await ctx().bus.emit('handover.accepted', { handoverId: id, branchId: h.branchId, fromUserId: h.fromUserId, toUserId: h.toUserId, customerIds: ids });
}

export async function accept(user: AuthUser, id: string, meta: RequestMeta) {
  const h = await load(user, id);
  if (h.toUserId !== user.id) throw notFound('handover'); // only the receiver
  const now = ctx().clock.now();
  if (h.status === 'pending_acceptance' && now > h.expiresAt) {
    await move(h, 'expire', { decidedAt: now });
    throw new AppError('INVALID_STATE', { reason: 'HANDOVER_EXPIRED' });
  }
  await move(h, 'accept', { decidedAt: now });
  await audit.record({ actor: user, action: 'handover.accepted', entity: 'handover', entityId: id, branchId: h.branchId, meta });
  const fresh = (await HandoverModel.findById(id).lean()) as Lean;
  if (dueToApply({ status: fresh.status, appliedAt: fresh.appliedAt, effectiveDate: fresh.effectiveDate }, today())) await apply(fresh, user.id);
  return view((await HandoverModel.findById(id).lean()) as Lean);
}

export async function reject(user: AuthUser, id: string, reason: string, meta: RequestMeta) {
  const h = await load(user, id);
  if (h.toUserId !== user.id) throw notFound('handover');
  await move(h, 'reject', { decidedAt: ctx().clock.now(), decisionNote: reason });
  await audit.record({ actor: user, action: 'handover.rejected', entity: 'handover', entityId: id, branchId: h.branchId, reason, meta });
  await ctx().bus.emit('handover.rejected', { handoverId: id, branchId: h.branchId, createdBy: h.createdBy, toUserId: h.toUserId });
  return view((await HandoverModel.findById(id).lean()) as Lean);
}

export async function cancel(user: AuthUser, id: string, meta: RequestMeta) {
  const h = await load(user, id);
  if (!(await can(user, 'handover.create'))) throw notFound('handover');
  await move(h, 'cancel', { decidedAt: ctx().clock.now() });
  await audit.record({ actor: user, action: 'handover.cancelled', entity: 'handover', entityId: id, branchId: h.branchId, meta });
  await ctx().bus.emit('handover.cancelled', { handoverId: id, toUserId: h.toUserId });
  return view((await HandoverModel.findById(id).lean()) as Lean);
}

/** Job (every 15 min): remind at 24 h, expire at 72 h, apply on effective date, revert temporary covers. */
export async function tick(): Promise<{ expired: number; applied: number; reverted: number; reminded: number }> {
  const now = ctx().clock.now();
  const date = today();
  const out = { expired: 0, applied: 0, reverted: 0, reminded: 0 };
  for (const h of (await HandoverModel.find({ status: 'pending_acceptance', expiresAt: { $lte: now } }).lean()) as Lean[]) {
    try {
      await move(h, 'expire', { decidedAt: now });
      out.expired++;
      await ctx().bus.emit('handover.expired', { handoverId: h._id.toHexString(), branchId: h.branchId, createdBy: h.createdBy, toUserId: h.toUserId });
    } catch {
      /* raced with accept */
    }
  }
  const remindBefore = new Date(now.getTime() - REMIND_AFTER_HOURS * 3_600_000);
  for (const h of (await HandoverModel.find({ status: 'pending_acceptance', remindedAt: null, createdAt: { $lte: remindBefore } }).lean()) as Lean[]) {
    await HandoverModel.updateOne({ _id: h._id }, { $set: { remindedAt: now } });
    await ctx().bus.emit('handover.unaccepted', { handoverId: h._id.toHexString(), branchId: h.branchId, toUserId: h.toUserId });
    out.reminded++;
  }
  for (const h of (await HandoverModel.find({ status: 'accepted', appliedAt: null, effectiveDate: { $lte: date } }).lean()) as Lean[]) {
    await apply(h, 'system');
    out.applied++;
  }
  for (const h of (await HandoverModel.find({ status: 'accepted', appliedAt: { $ne: null }, endDate: { $ne: null, $lt: date } }).lean()) as Lean[]) {
    if (!dueToRevert({ status: h.status, appliedAt: h.appliedAt, endDate: h.endDate }, date)) continue;
    const id = h._id.toHexString();
    const ok = await withTransaction(async (session) => {
      const r = await HandoverModel.updateOne({ _id: h._id, status: 'accepted' }, { $set: { status: 'reverted', revertedAt: now } }, { session });
      if (r.modifiedCount !== 1) return false;
      await revertTransfer({ branchId: h.branchId, source: `handover:${id}`, ended: h.transfer?.ended ?? [], by: 'system' }, session);
      await audit.record({ actor: null, action: 'handover.reverted', entity: 'handover', entityId: id, branchId: h.branchId }, session);
      return true;
    });
    if (!ok) continue;
    await recomputeBranch(h.branchId);
    await ctx().bus.emit('handover.reverted', { handoverId: id, branchId: h.branchId, fromUserId: h.fromUserId, toUserId: h.toUserId });
    out.reverted++;
  }
  return out;
}

/** user.deactivated → cancel pending handovers to or from them. */
export async function onUserDeactivated(userId: string): Promise<void> {
  const rows = (await HandoverModel.find({ status: 'pending_acceptance', $or: [{ fromUserId: userId }, { toUserId: userId }] }).lean()) as Lean[];
  for (const h of rows) await move(h, 'cancel', { decidedAt: ctx().clock.now(), decisionNote: 'user deactivated' }).catch(() => undefined);
}

export const pendingFor = async (userId: string) => HandoverModel.countDocuments({ toUserId: userId, status: 'pending_acceptance' });
