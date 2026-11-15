import { z } from 'zod';
import { ctx } from '../../core/context/index.js';
import { AppError, businessRule, notFound } from '../../core/errors/index.js';
import { isOid, withTransaction } from '../../core/db/index.js';
import { recordChange } from '../../core/changefeed/index.js';
import { payloadHash, withIdempotency } from '../../core/idempotency/index.js';
import { decodeCursor, encodeCursor } from '../../core/http/index.js';
import { businessDate, isIsoDate } from '../../core/time/index.js';
import { branchQuery, canSeeBranch, isSuperAdmin, type AuthUser } from '../../core/security/types.js';
import type { RequestMeta } from '../../core/http/router.js';
import * as audit from '../audit/index.js';
import { getSetting } from '../settings/index.js';
import { getUser, getUsers, listByRole, type UserView } from '../users/index.js';
import { cashCollectionsOf, cashSums } from '../collections/index.js';
import { oldestUndeposited, onHand, stateOf } from './domain/position.js';
import { ClosingModel, DepositModel } from './models/cash.model.js';

type Lean = Record<string, any> & { _id: { toHexString(): string } };
const today = () => businessDate(ctx().clock.now());

async function limitFor(u: UserView): Promise<number> {
  return u.cashLimitPoisha ?? (await getSetting<number>('cash.limitPoisha', u.branchIds[0] ?? null)) ?? 5_000_000;
}

async function depositTotals(userIds: string[]) {
  const rows = await DepositModel.aggregate([
    { $match: { userId: { $in: userIds }, status: { $in: ['pending', 'verified'] } } },
    { $group: { _id: '$userId', total: { $sum: '$amountPoisha' }, pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, '$amountPoisha', 0] } } } },
  ]);
  return new Map<string, { total: number; pending: number }>(rows.map((r: { _id: string; total: number; pending: number }) => [r._id, r]));
}

/** FR-CASH-001: Σ cash collections (not voided/refunded) − Σ pending+verified deposits. */
export async function positions(users: UserView[]) {
  const ids = users.map((u) => u.id);
  const [sums, deps] = [await cashSums(ids, today()), await depositTotals(ids)];
  const out = [];
  for (const u of users) {
    const s = sums.get(u.id);
    const d = deps.get(u.id) ?? { total: 0, pending: 0 };
    const hand = onHand(s?.cashPoisha ?? 0, d.total);
    const limit = await limitFor(u);
    const oldest = hand > 0 ? oldestUndeposited(await cashCollectionsOf(u.id), d.total) : null;
    out.push({
      userId: u.id,
      userName: u.name.en || u.name.bn,
      onHandPoisha: hand,
      limitPoisha: limit,
      state: stateOf(hand, limit),
      oldestUndepositedAt: oldest ? oldest.toISOString() : null,
      pendingDepositsPoisha: d.pending,
      todayCashPoisha: s?.todayCashPoisha ?? 0,
      todayMobilePoisha: s?.todayMobilePoisha ?? 0,
    });
  }
  return out;
}

export async function positionOf(userId: string) {
  const u = await getUser(userId);
  if (!u) throw notFound('user');
  return (await positions([u]))[0]!;
}

export async function branchPositions(user: AuthUser, branchId?: string) {
  if (branchId && !canSeeBranch(user, branchId)) return [];
  const branches = branchId ? [branchId] : isSuperAdmin(user) ? undefined : user.branchIds;
  const staff = await listByRole(['field_staff'], branches);
  const scoped = user.role === 'field_staff' ? staff.filter((u) => u.id === user.id) : staff;
  return (await positions(scoped)).sort((a, b) => b.onHandPoisha - a.onHandPoisha);
}

// ---------------- deposits (FR-CASH-003/004) ----------------

export const depositSchema = z.object({
  clientId: z.string().uuid(),
  amountPoisha: z.number().int().min(1),
  destination: z.enum(['branch_cashier', 'bank', 'manager']),
  reference: z.string().max(100).optional(),
  slipMediaId: z.string().max(64).optional(),
  depositedAt: z.string().datetime({ offset: true }),
  geo: z.object({ lat: z.number(), lng: z.number(), accuracyM: z.number().min(0) }).passthrough().nullable().optional(),
});

function view(d: Lean, userName?: string) {
  return {
    ...(userName !== undefined ? { userName } : {}),
    id: d._id.toHexString(),
    clientId: d.clientId,
    userId: d.userId,
    amountPoisha: d.amountPoisha,
    destination: d.destination,
    ...(d.reference ? { reference: d.reference } : {}),
    ...(d.slipMediaId ? { slipMediaId: d.slipMediaId } : {}),
    depositedAt: (d.depositedAt as Date).toISOString(),
    status: d.status,
    ...(d.verifiedBy ? { verifiedBy: d.verifiedBy, verifiedAt: (d.verifiedAt as Date).toISOString() } : {}),
    ...(d.rejectReason ? { rejectReason: d.rejectReason } : {}),
  };
}

export async function createDeposit(user: AuthUser, key: string, input: z.infer<typeof depositSchema>, meta: RequestMeta) {
  return withIdempotency('deposit', `${user.id}:${key}`, payloadHash(input as unknown as Record<string, unknown>, ['clientId', 'amountPoisha', 'destination', 'depositedAt']), async () => {
    if (input.destination === 'bank' && !input.slipMediaId) throw businessRule('SLIP_REQUIRED');
    const pos = await positionOf(user.id);
    if (input.amountPoisha > pos.onHandPoisha) throw businessRule('DEPOSIT_EXCEEDS_ON_HAND', { onHandPoisha: pos.onHandPoisha });
    const u = (await getUser(user.id))!;
    const branchId = u.branchIds[0]!;
    const d = await withTransaction(async (session) => {
      const [doc] = await DepositModel.create(
        [{ ...input, reference: input.reference ?? null, slipMediaId: input.slipMediaId ?? null, geo: input.geo ? { lat: input.geo.lat, lng: input.geo.lng, accuracyM: input.geo.accuracyM } : null, depositedAt: new Date(input.depositedAt), userId: user.id, branchId, createdAt: ctx().clock.now() }],
        { session },
      );
      await recordChange({ entity: 'deposit', entityId: doc!._id.toHexString(), userIds: [user.id], branchId }, session);
      await audit.record({ actor: user, action: 'cash.deposit.recorded', entity: 'deposit', entityId: doc!._id.toHexString(), branchId, after: { amountPoisha: input.amountPoisha, destination: input.destination }, meta, money: true }, session);
      return doc!.toObject() as Lean;
    });
    await ctx().bus.emit('cash.deposit.recorded', { depositId: d._id.toHexString(), branchId, userId: user.id, amountPoisha: d.amountPoisha });
    return { statusCode: 201, body: view(d), entityId: d._id.toHexString() };
  });
}

export async function listDeposits(user: AuthUser, q: { branchId?: string | undefined; status?: string | undefined; limit: number; cursor?: string | undefined }) {
  const f: Record<string, unknown> = { ...branchQuery(user, q.branchId), ...(user.role === 'field_staff' ? { userId: user.id } : {}), ...(q.status ? { status: q.status } : {}) };
  const cur = decodeCursor<{ id: string }>(q.cursor);
  const rows = (await DepositModel.find({ ...f, ...(cur ? { _id: { $lt: cur.id } } : {}) }).sort({ _id: -1 }).limit(q.limit + 1).lean()) as Lean[];
  const items = rows.slice(0, q.limit);
  const users = await getUsers(items.map((d) => d.userId));
  return {
    items: items.map((d) => view(d, users.get(d.userId)?.name.en || users.get(d.userId)?.name.bn || '')),
    nextCursor: rows.length > q.limit ? encodeCursor({ id: items[items.length - 1]!._id.toHexString() }) : null,
  };
}

export async function getDeposit(user: AuthUser, id: string) {
  if (!isOid(id)) throw notFound('deposit');
  const d = (await DepositModel.findOne({ _id: id, ...branchQuery(user, undefined), ...(user.role === 'field_staff' ? { userId: user.id } : {}) }).lean()) as Lean | null;
  if (!d) throw notFound('deposit');
  return view(d);
}

export async function decide(user: AuthUser, id: string, decision: 'verify' | 'reject', reason: string | null, meta: RequestMeta) {
  if (!isOid(id)) throw notFound('deposit');
  const d = (await DepositModel.findOne({ _id: id, ...branchQuery(user, undefined) }).lean()) as Lean | null;
  if (!d) throw notFound('deposit');
  if (d.userId === user.id) throw businessRule('CANNOT_VERIFY_OWN_DEPOSIT');
  const now = ctx().clock.now();
  const set = decision === 'verify' ? { status: 'verified', verifiedBy: user.id, verifiedAt: now } : { status: 'rejected', verifiedBy: user.id, verifiedAt: now, rejectReason: reason };
  await withTransaction(async (session) => {
    const r = await DepositModel.updateOne({ _id: id, status: 'pending' }, { $set: set }, { session });
    if (r.modifiedCount !== 1) throw new AppError('INVALID_STATE', { reason: 'ALREADY_DECIDED', status: d.status });
    await recordChange({ entity: 'deposit', entityId: id, userIds: [d.userId], branchId: d.branchId }, session);
    await audit.record({ actor: user, action: `cash.deposit.${decision === 'verify' ? 'verified' : 'rejected'}`, entity: 'deposit', entityId: id, branchId: d.branchId, before: { status: 'pending' }, after: { status: set.status }, reason, meta, money: true }, session);
  });
  await ctx().bus.emit(`cash.deposit.${decision === 'verify' ? 'verified' : 'rejected'}`, { depositId: id, userId: d.userId, branchId: d.branchId, reason });
  return view((await DepositModel.findById(id).lean()) as Lean);
}

// ---------------- closing (FR-CASH-006) ----------------

export async function close(user: AuthUser, input: { businessDate: string; note?: string | undefined }) {
  if (!isIsoDate(input.businessDate) || input.businessDate > today()) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'businessDate', message: 'today or earlier' }] });
  const pos = await positionOf(user.id);
  const deposited = await DepositModel.aggregate([{ $match: { userId: user.id, status: { $in: ['pending', 'verified'] }, depositedAt: { $gte: new Date(`${input.businessDate}T00:00:00+06:00`), $lte: new Date(`${input.businessDate}T23:59:59.999+06:00`) } } }, { $group: { _id: null, s: { $sum: '$amountPoisha' } } }]);
  const u = (await getUser(user.id))!;
  const doc = {
    userId: user.id,
    branchId: u.branchIds[0]!,
    businessDate: input.businessDate,
    cashCollectedPoisha: input.businessDate === today() ? pos.todayCashPoisha : null,
    mobileCollectedPoisha: input.businessDate === today() ? pos.todayMobilePoisha : null,
    depositedPoisha: deposited[0]?.s ?? 0,
    onHandPoisha: pos.onHandPoisha,
    confirmedAt: ctx().clock.now(),
    note: input.note ?? null,
  };
  // One closing per staff per day; re-confirming replaces the snapshot (idempotent for offline retries).
  await ClosingModel.updateOne({ userId: user.id, businessDate: input.businessDate }, { $set: doc }, { upsert: true });
  return { ...doc, confirmedAt: doc.confirmedAt.toISOString() };
}

/** After each received cash collection: warn the collector + manager once the 80 % line is crossed (FR-CASH-002). */
export async function onCollectionReceived(p: { collectorId: string; branchId: string; method: string; amountPoisha: number }) {
  if (p.method !== 'cash') return;
  const pos = await positionOf(p.collectorId);
  const before = stateOf(pos.onHandPoisha - p.amountPoisha, pos.limitPoisha);
  if (pos.state !== 'ok' && pos.state !== before)
    await ctx().bus.emit('cash.limit_reached', { userId: p.collectorId, branchId: p.branchId, state: pos.state, onHandPoisha: pos.onHandPoisha, limitPoisha: pos.limitPoisha });
}

/** Dashboard totals for the caller's scope. */
export async function cashOverview(user: AuthUser, branchId?: string) {
  const pos = await branchPositions(user, branchId);
  const pendingDeposits = await DepositModel.countDocuments({ ...branchQuery(user, branchId), ...(user.role === 'field_staff' ? { userId: user.id } : {}), status: 'pending' });
  return { onHandPoisha: pos.reduce((s, p) => s + p.onHandPoisha, 0), overLimitStaff: pos.filter((p) => p.state === 'exceeded').length, pendingDeposits };
}
