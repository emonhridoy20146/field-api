import { z } from 'zod';
import { ctx } from '../../core/context/index.js';
import { AppError, businessRule, notFound } from '../../core/errors/index.js';
import { isOid, withTransaction, type LeanDoc } from '../../core/db/index.js';
import { recordChange } from '../../core/changefeed/index.js';
import { payloadHash, withIdempotency } from '../../core/idempotency/index.js';
import { decodeCursor, encodeCursor } from '../../core/http/index.js';
import { businessDate, isIsoDate } from '../../core/time/index.js';
import { branchQuery, canSeeBranch, isSuperAdmin, type AuthUser } from '../../core/security/types.js';
import type { RequestMeta } from '../../core/http/router.js';
import * as audit from '../audit/index.js';
import { getSetting } from '../settings/index.js';
import { getUser, getUsers, listByRole, type UserView } from '../users/index.js';
import { cashCollectionRows, cashSums, depositRows, heldNonCash, submitForDeposit } from '../collections/index.js';
import { promisesBehind } from '../promises/index.js';
import { depositCoverage, inHandBreakdown, stateOf } from './domain/position.js';
import { ClosingModel, DepositModel } from './models/cash.model.js';

type Lean = LeanDoc;
const today = () => businessDate(ctx().clock.now());
/** Deposits that count: `submitted` (1.35.0, final) and the `pending` / `verified` ones recorded before 1.35.0. */
const COUNTED = ['pending', 'verified', 'submitted'];

async function limitFor(u: UserView): Promise<number> {
  return u.cashLimitPoisha ?? (await getSetting<number>('cash.limitPoisha', u.branchIds[0] ?? null)) ?? 5_000_000;
}

async function depositTotals(userIds: string[]) {
  const rows = await DepositModel.aggregate([
    { $match: { userId: { $in: userIds }, status: { $in: COUNTED } } },
    { $group: { _id: '$userId', total: { $sum: '$amountPoisha' }, pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, '$amountPoisha', 0] } } } },
  ]);
  return new Map<string, { total: number; pending: number }>(rows.map((r: { _id: string; total: number; pending: number }) => [r._id, r]));
}

type CashRows = Awaited<ReturnType<typeof cashCollectionRows>>;

/**
 * The cash a person holds (FR-CASH-001/007, 1.35.0). A collection a deposit took (`depositId`) is out of hand. Deposits
 * from before 1.35.0 carry no list: what they paid that is not linked to a collection is taken off the oldest unlinked
 * cash, as before. So voiding a deposited collection never moves other cash in or out of hand.
 */
async function handState(userId: string, rows?: CashRows) {
  const all = rows ?? (await cashCollectionRows(userId));
  const deps = (await DepositModel.find({ userId, status: { $in: COUNTED } }).select({ amountPoisha: 1, collectionIds: 1, legacyAbsorbedPoisha: 1 }).lean()) as Lean[];
  const legacy = new Set(deps.filter((d) => !d.collectionIds).map((d) => d._id.toHexString() as string));
  const legacyTotal = deps.filter((d) => !d.collectionIds).reduce((n, d) => n + (d.amountPoisha as number), 0);
  const linkedToLegacy = all.filter((r) => r.depositId && legacy.has(r.depositId)).reduce((n, r) => n + r.amountPoisha, 0);
  // a 1.35.0 deposit that took a collection an older deposit had partly paid records that part, so it is not counted again
  const absorbed = deps.reduce((n, d) => n + ((d.legacyAbsorbedPoisha as number | undefined) ?? 0), 0);
  const inHand = inHandBreakdown(all.filter((r) => !r.depositId), Math.max(0, legacyTotal - linkedToLegacy - absorbed));
  return { rows: all, inHand, onHandPoisha: inHand.reduce((n, c) => n + c.inHandPoisha, 0) };
}

/** FR-CASH-001: the cash collections (not voided/refunded) still in hand, see `handState`. */
export async function positions(users: UserView[]) {
  const ids = users.map((u) => u.id);
  const [sums, deps] = [await cashSums(ids, today()), await depositTotals(ids)];
  const out = [];
  for (const u of users) {
    const s = sums.get(u.id);
    const d = deps.get(u.id) ?? { total: 0, pending: 0 };
    const st = (s?.cashPoisha ?? 0) > 0 ? await handState(u.id) : null;
    const hand = st?.onHandPoisha ?? 0;
    const limit = await limitFor(u);
    const oldest = st?.inHand[0]?.recordedAt ?? null;
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

/** How many collections one answer lists; the newest cash matters most, and the totals cover all of it. */
const IN_HAND_LIMIT = 200;

/**
 * FR-CASH-007: the collections behind a person's cash on hand: receipt, customer, invoice and how much of each is
 * still in hand after the deposits (oldest paid off first). A field staff member reads their own; a manager reads
 * staff in their scope (404 otherwise).
 */
export async function inHandOf(actor: AuthUser, userId: string) {
  if (!isOid(userId)) throw notFound('user');
  const u = await getUser(userId);
  // out of scope answers like "no such user"
  const mayRead = !!u && (actor.id === u.id || (actor.role !== 'field_staff' && u.branchIds.some((b) => canSeeBranch(actor, b))));
  if (!u || !mayRead) throw notFound('user');
  const deps = (await depositTotals([u.id])).get(u.id) ?? { total: 0, pending: 0 };
  const all = (await handState(u.id)).inHand;
  // newest first: what was collected last is what is most surely still in the pocket
  const items = all.reverse().slice(0, IN_HAND_LIMIT);
  return {
    userId: u.id,
    userName: u.name.en || u.name.bn,
    onHandPoisha: all.reduce((n, c) => n + c.inHandPoisha, 0),
    pendingDepositsPoisha: deps.pending,
    count: all.length,
    items: await withPromises(items),
    generatedAt: ctx().clock.now().toISOString(),
  };
}

/** One line of cash in hand or of a deposit (a deposit line also says its method and ERP receipt). */
type CashRow = Omit<Awaited<ReturnType<typeof cashCollectionRows>>[number], 'depositId'>;

/** FR-CASH-008: each line says which promise it was collected against and how that promise ended (or null). */
async function withPromises<T extends CashRow>(rows: T[]) {
  const promises = await promisesBehind(rows.map((c) => ({ id: c.collectionId, customerId: c.customer.id, erpPlanId: c.erpPlanId || null, businessDate: c.businessDate, branchId: c.branchId })));
  return rows.map(({ branchId: _b, ...c }) => {
    void _b;
    return { ...c, recordedAt: c.recordedAt.toISOString(), promise: promises.get(c.collectionId) ?? null };
  });
}

/**
 * FR-CASH-008: the collections one deposit covered. The person's deposits (pending and verified, oldest first) pay
 * off their cash collections oldest-first, the same order the cash in hand uses, so a deposit's lines and the cash
 * in hand never overlap. Scope is the deposit's (`getDeposit`): out of scope is 404.
 */
export async function depositCollections(user: AuthUser, id: string) {
  const deposit = await getDeposit(user, id);
  const deps = (await DepositModel.find({ userId: deposit.userId, status: { $in: COUNTED } }).sort({ depositedAt: 1, _id: 1 }).select({ amountPoisha: 1 }).lean()) as Lean[];
  const order = deps.map((d) => ({ id: d._id.toHexString() as string, amountPoisha: d.amountPoisha as number }));
  const rows = await cashCollectionRows(deposit.userId);
  // 1.35.0: a deposit lists the collections it took (cash and the rest); older deposits are worked out oldest-first.
  if (deposit.status === 'submitted') {
    const linked = await depositRows(deposit.id);
    const u0 = await getUser(deposit.userId);
    return {
      deposit: { ...deposit, userName: u0?.name.en || u0?.name.bn || '' },
      coveredPoisha: linked.filter((c) => c.method === 'cash').reduce((n, c) => n + c.amountPoisha, 0),
      unmatchedPoisha: 0,
      items: await withPromises(linked.map((c) => ({ ...c, coveredPoisha: c.amountPoisha, inHandPoisha: 0 }))),
      generatedAt: ctx().clock.now().toISOString(),
    };
  }
  const cov = deposit.status === 'rejected' || deposit.status === 'deleted' ? { items: [], coveredPoisha: 0, unmatchedPoisha: 0 } : depositCoverage(rows, order, deposit.id);
  if (!cov) throw notFound('deposit');
  // the same line also says what is still in hand of it after every deposit (0 for most covered lines)
  const total = order.reduce((n, d) => n + d.amountPoisha, 0);
  const inHand = new Map(inHandBreakdown(rows, total).map((c) => [c.collectionId, c.inHandPoisha]));
  const u = await getUser(deposit.userId);
  return {
    deposit: { ...deposit, userName: u?.name.en || u?.name.bn || '' },
    coveredPoisha: cov.coveredPoisha,
    unmatchedPoisha: cov.unmatchedPoisha,
    items: await withPromises(cov.items.map((c) => ({ ...c, inHandPoisha: inHand.get(c.collectionId) ?? 0 }))),
    generatedAt: ctx().clock.now().toISOString(),
  };
}

// ---------------- deposits (FR-CASH-003/004) ----------------

export const depositSchema = z.object({
  clientId: z.string().uuid(),
  // 1.35.0: the cash handed over, which must be all the cash in hand; 0 when only mobile/bank collections are handed in.
  amountPoisha: z.number().int().min(0),
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
    ...(d.collectionIds ? { collectionCount: (d.collectionIds as string[]).length, nonCashPoisha: (d.nonCashPoisha as number | undefined) ?? 0, nonCashCount: (d.nonCashCount as number | undefined) ?? 0 } : {}),
    ...(d.verifiedBy ? { verifiedBy: d.verifiedBy, verifiedAt: (d.verifiedAt as Date).toISOString() } : {}),
    ...(d.rejectReason ? { rejectReason: d.rejectReason } : {}),
    ...(d.status === 'deleted' ? { deletedBy: d.deletedBy, deletedAt: (d.deletedAt as Date).toISOString(), deleteReason: d.deleteReason } : {}),
  };
}

/**
 * FR-CASH-003 / 1.35.0 FR-CASH-010 (ADR-049): the collector hands in everything in hand at once: all the cash (the
 * amount must be exactly the cash in hand) and every mobile banking, bank or card collection not handed in yet. The
 * deposit is final: it takes those collections, each goes to the ERP (now, or when the ERP is switched on), and none of
 * them can be edited or withdrawn after it. No office confirmation.
 */
export async function createDeposit(user: AuthUser, key: string, input: z.infer<typeof depositSchema>, meta: RequestMeta) {
  return withIdempotency('deposit', `${user.id}:${key}`, payloadHash(input as unknown as Record<string, unknown>, ['clientId', 'amountPoisha', 'destination', 'depositedAt']), async () => {
    if (input.destination === 'bank' && !input.slipMediaId) throw businessRule('SLIP_REQUIRED');
    const pos = await positionOf(user.id);
    if (input.amountPoisha > pos.onHandPoisha) throw businessRule('DEPOSIT_EXCEEDS_ON_HAND', { onHandPoisha: pos.onHandPoisha });
    if (input.amountPoisha < pos.onHandPoisha) throw businessRule('DEPOSIT_MUST_BE_ALL', { onHandPoisha: pos.onHandPoisha });
    const cash = pos.onHandPoisha > 0 ? (await handState(user.id)).inHand : [];
    const other = await heldNonCash(user.id);
    if (!cash.length && !other.length) throw businessRule('NOTHING_TO_DEPOSIT');
    const ids = [...cash.map((c) => c.collectionId), ...other.map((c) => c.collectionId)];
    const u = (await getUser(user.id))!;
    const branchId = u.branchIds[0]!;
    const now = ctx().clock.now();
    const d = await withTransaction(async (session) => {
      const [doc] = await DepositModel.create(
        [
          {
            ...input,
            reference: input.reference ?? null,
            slipMediaId: input.slipMediaId ?? null,
            geo: input.geo ? { lat: input.geo.lat, lng: input.geo.lng, accuracyM: input.geo.accuracyM } : null,
            depositedAt: new Date(input.depositedAt),
            userId: user.id,
            branchId,
            status: 'submitted',
            collectionIds: ids,
            nonCashPoisha: other.reduce((n, c) => n + c.amountPoisha, 0),
            nonCashCount: other.length,
            ...(cash.some((c) => c.inHandPoisha < c.amountPoisha) ? { legacyAbsorbedPoisha: cash.reduce((n, c) => n + c.amountPoisha - c.inHandPoisha, 0) } : {}),
            createdAt: now,
          },
        ],
        { session },
      );
      const id = doc!._id.toHexString();
      // Another deposit or a void took one of them meanwhile: nothing is saved, the phone shows the error.
      if ((await submitForDeposit(user.id, id, ids, now, session)) !== ids.length) throw new AppError('INVALID_STATE', { reason: 'STATUS_CHANGED' });
      await recordChange({ entity: 'deposit', entityId: id, userIds: [user.id], branchId }, session);
      await audit.record({ actor: user, action: 'cash.deposit.recorded', entity: 'deposit', entityId: id, branchId, after: { amountPoisha: input.amountPoisha, destination: input.destination, collections: ids.length, nonCashPoisha: other.reduce((n, c) => n + c.amountPoisha, 0) }, meta, money: true }, session);
      return doc!.toObject() as Lean;
    });
    await ctx().bus.emit('cash.deposit.submitted', { depositId: d._id.toHexString(), branchId, userId: user.id, amountPoisha: d.amountPoisha, collections: ids.length });
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

/**
 * Verify, reject (FR-CASH-004) and delete (FR-CASH-009) are retired in 1.35.0 (ADR-049): a deposit is final, and what
 * it handed in is in the ERP or on its way there. The routes stay (v1 is additive-only) and answer 409 DEPOSIT_FINAL.
 */
async function refuseFinal(user: AuthUser, id: string): Promise<never> {
  if (!isOid(id)) throw notFound('deposit');
  const d = (await DepositModel.findOne({ _id: id, ...branchQuery(user, undefined) }).lean()) as Lean | null;
  if (!d) throw notFound('deposit');
  throw new AppError('INVALID_STATE', { reason: 'DEPOSIT_FINAL', status: d.status });
}

export async function decide(user: AuthUser, id: string, _decision: 'verify' | 'reject', _reason: string | null, _meta: RequestMeta): Promise<never> {
  return refuseFinal(user, id);
}

export async function deleteDeposit(user: AuthUser, id: string, _reason: string, _meta: RequestMeta): Promise<never> {
  return refuseFinal(user, id);
}

/**
 * 1.35.0 migration (ADR-049): a deposit recorded before 1.35.0 (pending or verified, no collection list) takes the
 * cash collections it covered in full, oldest-first as before, so they go to the ERP like any deposited collection.
 * A collection it covered only in part stays in hand and goes with the next deposit. Safe to run again.
 */
export async function linkLegacyDeposits(): Promise<number> {
  const legacy = (await DepositModel.find({ status: { $in: ['pending', 'verified'] }, collectionIds: { $exists: false } }).sort({ depositedAt: 1, _id: 1 }).lean()) as Lean[];
  let linked = 0;
  for (const userId of new Set(legacy.map((d) => d.userId as string))) {
    const deps = (await DepositModel.find({ userId, status: { $in: COUNTED } }).sort({ depositedAt: 1, _id: 1 }).select({ amountPoisha: 1, collectionIds: 1 }).lean()) as Lean[];
    const order = deps.map((d) => ({ id: d._id.toHexString() as string, amountPoisha: d.amountPoisha as number }));
    const rows = await cashCollectionRows(userId);
    for (const d of deps) {
      if (d.collectionIds) continue;
      const cov = depositCoverage(rows, order, d._id.toHexString());
      const full = (cov?.items ?? []).filter((c) => c.coveredPoisha === c.amountPoisha).map((c) => c.collectionId);
      if (!full.length) continue;
      linked += await withTransaction((session) => submitForDeposit(userId, d._id.toHexString(), full, d.depositedAt as Date, session));
    }
  }
  return linked;
}

/** How much of a cash collection is no longer in hand: all of it once a deposit took it, else what older deposits covered. */
export async function coveredOfCollection(collectorId: string, collectionId: string): Promise<number> {
  const st = await handState(collectorId);
  const row = st.rows.find((r) => r.collectionId === collectionId);
  if (!row) return 0;
  if (row.depositId) return row.amountPoisha;
  return row.amountPoisha - (st.inHand.find((r) => r.collectionId === collectionId)?.inHandPoisha ?? 0);
}

// ---------------- closing (FR-CASH-006) ----------------

export async function close(user: AuthUser, input: { businessDate: string; note?: string | undefined }) {
  if (!isIsoDate(input.businessDate) || input.businessDate > today()) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'businessDate', message: 'today or earlier' }] });
  const pos = await positionOf(user.id);
  const deposited = await DepositModel.aggregate([{ $match: { userId: user.id, status: { $in: COUNTED }, depositedAt: { $gte: new Date(`${input.businessDate}T00:00:00+06:00`), $lte: new Date(`${input.businessDate}T23:59:59.999+06:00`) } } }, { $group: { _id: null, s: { $sum: '$amountPoisha' } } }]);
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
