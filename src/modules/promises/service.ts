import { z } from 'zod';
import { ctx } from '../../core/context/index.js';
import { AppError, businessRule, notFound } from '../../core/errors/index.js';
import { isDuplicateKey, isOid, type LeanDoc } from '../../core/db/index.js';
import { recordChange } from '../../core/changefeed/index.js';
import { decodeCursor, encodeCursor } from '../../core/http/index.js';
import { formatBdt } from '../../core/money/index.js';
import { businessDate, isIsoDate } from '../../core/time/index.js';
import { branchQuery, isSuperAdmin, type AuthUser } from '../../core/security/types.js';
import { getSetting } from '../settings/index.js';
import { getUsers } from '../users/index.js';
import { erpPaidBetween, getCustomerRef, getCustomerRefs, setOpenPromiseDates, type TimelineItem } from '../customers/index.js';
import { dateInRange, isDue, promiseFor, verdict } from './domain/evaluate.js';
import { PromiseModel } from './models/promise.model.js';

type Lean = LeanDoc;
const today = () => businessDate(ctx().clock.now());

export const createSchema = z.object({
  clientId: z.string().uuid(),
  customerId: z.string().max(64),
  erpPlanId: z.string().max(64).optional(),
  promisedDate: z.string().refine(isIsoDate, 'YYYY-MM-DD'),
  promisedAmountPoisha: z.number().int().min(1),
  note: z.string().max(500).optional(),
});

function view(p: Lean) {
  return {
    id: p._id.toHexString(),
    clientId: p.clientId,
    customerId: p.customerId,
    ...(p.erpPlanId ? { erpPlanId: p.erpPlanId } : {}),
    promisedDate: p.promisedDate,
    promisedAmountPoisha: p.promisedAmountPoisha,
    ...(p.note ? { note: p.note } : {}),
    ownerId: p.ownerId,
    status: p.status,
    paidTowardsPoisha: p.paidTowardsPoisha ?? 0,
    createdAt: (p.createdAt as Date).toISOString(),
  };
}

export function scopeFilter(user: AuthUser): Record<string, unknown> {
  if (isSuperAdmin(user)) return {};
  if (user.role === 'field_staff') return { ownerId: user.id };
  return { branchId: { $in: user.branchIds } };
}

/** Keep the customers overlay (`promised_today` filter) in step with open promises. */
async function syncOverlay(customerId: string) {
  const open = await PromiseModel.find({ customerId, status: 'open' }).select('promisedDate').lean();
  await setOpenPromiseDates(customerId, [...new Set(open.map((p) => p.promisedDate))]);
}

async function touch(p: Lean) {
  await recordChange({ entity: 'promise', entityId: p._id.toHexString(), userIds: [p.ownerId], branchId: p.branchId });
}

/** FR-PRM-001: one open promise per plan; a new one supersedes the old (history kept). Idempotent by clientId. */
export async function create(user: AuthUser, input: z.infer<typeof createSchema>): Promise<{ statusCode: 200 | 201; body: ReturnType<typeof view> }> {
  const prior = (await PromiseModel.findOne({ clientId: input.clientId }).lean()) as Lean | null;
  if (prior) {
    if (prior.createdBy !== user.id) throw new AppError('IDEMPOTENCY_MISMATCH', { clientId: input.clientId });
    return { statusCode: 200, body: view(prior) };
  }
  const c = await getCustomerRef(user, input.customerId);
  if (!c?.branchId) throw notFound('customer');
  if (!dateInRange(input.promisedDate, today())) throw businessRule('PROMISE_DATE_RANGE', { min: today(), maxDaysAhead: 60 });
  const active = c.plans.filter((p) => p.status === 'active');
  const erpPlanId = input.erpPlanId ?? (active.length === 1 ? active[0]!.erpPlanId : null);
  if (!erpPlanId && active.length > 1) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'erpPlanId', message: 'required when the customer has more than one active plan' }] });
  const now = ctx().clock.now();
  try {
    const old = (await PromiseModel.find({ customerId: c.id, erpPlanId, status: 'open' }).lean()) as Lean[];
    const doc = await PromiseModel.create({
      clientId: input.clientId,
      branchId: c.branchId,
      customerId: c.id,
      erpPlanId,
      ownerId: c.assigneeId ?? user.id,
      createdBy: user.id,
      promisedDate: input.promisedDate,
      promisedAmountPoisha: input.promisedAmountPoisha,
      note: input.note ?? null,
      createdAt: now,
      createdDate: today(),
    });
    for (const o of old) {
      await PromiseModel.updateOne({ _id: o._id, status: 'open' }, { $set: { status: 'superseded', closedAt: now, closeReason: `superseded by ${doc._id.toHexString()}` } });
      await touch(o);
    }
    const lean = doc.toObject() as Lean;
    await syncOverlay(c.id);
    await touch(lean);
    await ctx().bus.emit('promise.created', { promiseId: lean._id.toHexString(), customerId: c.id, branchId: c.branchId, ownerId: lean.ownerId, promisedDate: input.promisedDate });
    return { statusCode: 201, body: view(lean) };
  } catch (e) {
    if (isDuplicateKey(e)) return create(user, input);
    throw e;
  }
}

export async function cancel(user: AuthUser, id: string, reason: string) {
  if (!isOid(id)) throw notFound('promise');
  const p = (await PromiseModel.findOne({ _id: id, ...scopeFilter(user) }).lean()) as Lean | null;
  if (!p) throw notFound('promise');
  if (p.status !== 'open') throw new AppError('INVALID_STATE', { reason: 'PROMISE_NOT_OPEN', status: p.status });
  await PromiseModel.updateOne({ _id: id, status: 'open' }, { $set: { status: 'cancelled', closedAt: ctx().clock.now(), closeReason: reason } });
  await syncOverlay(p.customerId);
  await touch(p);
  return view((await PromiseModel.findById(id).lean()) as Lean);
}

/** List rows carry display refs so admin tables need no extra calls (contract 1.4.0). */
async function withRefs(rows: Lean[]) {
  const refs = await getCustomerRefs(rows.map((r) => r.customerId));
  const users = await getUsers(rows.map((r) => r.ownerId));
  return rows.map((p) => {
    const ref = refs.get(p.customerId);
    const u = users.get(p.ownerId);
    return { ...view(p), customer: { id: p.customerId, name: ref?.name ?? { bn: '', en: '' }, code: ref?.code ?? '' }, owner: { id: p.ownerId, name: u ? u.name.en || u.name.bn : '' } };
  });
}

export async function list(user: AuthUser, q: { branchId?: string | undefined; ownerId?: string | undefined; customerId?: string | undefined; date?: string | undefined; from?: string | undefined; to?: string | undefined; status?: string | undefined; limit: number; cursor?: string | undefined }) {
  const f: Record<string, unknown> = { ...scopeFilter(user), ...(q.branchId ? branchQuery(user, q.branchId) : {}) };
  if (q.ownerId && user.role !== 'field_staff') f.ownerId = q.ownerId;
  if (q.customerId) f.customerId = q.customerId;
  // `date` wins over the inclusive `from`/`to` range on the promised date.
  if (q.date) f.promisedDate = q.date;
  else if (q.from || q.to) f.promisedDate = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  if (q.status) f.status = q.status;
  const cur = decodeCursor<{ id: string }>(q.cursor);
  const rows = (await PromiseModel.find({ ...f, ...(cur ? { _id: { $lt: cur.id } } : {}) }).sort({ _id: -1 }).limit(q.limit + 1).lean()) as Lean[];
  const items = rows.slice(0, q.limit);
  return { items: await withRefs(items), nextCursor: rows.length > q.limit ? encodeCursor({ id: items[items.length - 1]!._id.toHexString() }) : null };
}

/** Bootstrap for a fresh device: the caller's own open promises, paged by id. */
export async function syncSnapshot(user: AuthUser, cursor: string | null, limit: number) {
  const c = decodeCursor<{ id: string }>(cursor ?? undefined);
  const rows = (await PromiseModel.find({ ownerId: user.id, status: 'open', ...(c ? { _id: { $gt: c.id } } : {}) }).sort({ _id: 1 }).limit(limit + 1).lean()) as Lean[];
  const page = rows.slice(0, limit);
  return { items: page.map(view), nextCursor: rows.length > limit ? encodeCursor({ id: page[page.length - 1]!._id.toHexString() }) : null };
}

export async function get(user: AuthUser, id: string) {
  if (!isOid(id)) throw notFound('promise');
  const p = (await PromiseModel.findOne({ _id: id, ...scopeFilter(user) }).lean()) as Lean | null;
  if (!p) throw notFound('promise');
  return view(p);
}

async function paidFor(p: Lean, until: string) {
  return erpPaidBetween(p.customerId, p.erpPlanId, p.createdDate, until);
}

async function closeWith(p: Lean, status: 'kept' | 'partially_kept' | 'broken', paid: number) {
  const r = await PromiseModel.updateOne({ _id: p._id, status: 'open' }, { $set: { status, paidTowardsPoisha: paid, closedAt: ctx().clock.now() } });
  if (r.modifiedCount !== 1) return;
  await syncOverlay(p.customerId);
  await touch(p);
  await ctx().bus.emit(status === 'kept' ? 'promise.kept' : 'promise.broken', { promiseId: p._id.toHexString(), customerId: p.customerId, branchId: p.branchId, ownerId: p.ownerId, status, paidTowardsPoisha: paid });
}

/**
 * FR-PRM-003 nightly: judge promises whose date + grace has passed. Paid = ERP payments on the plan from the day
 * the promise was made to promised date + grace (field collections count once ERP has them — money truth is ERP).
 */
export async function evaluateDue(): Promise<number> {
  const date = today();
  let n = 0;
  for (const p of (await PromiseModel.find({ status: 'open', promisedDate: { $lt: date } }).limit(5000).lean()) as Lean[]) {
    const grace = (await getSetting<number>('promises.graceDays', p.branchId)) ?? 1;
    if (!isDue(p.promisedDate, grace, date)) continue;
    const paid = await paidFor(p, date);
    await closeWith(p, verdict(paid, p.promisedAmountPoisha), paid);
    n++;
  }
  return n;
}

/** ERP sync for a customer: a promise is kept as soon as enough has been paid; progress is stored meanwhile. */
export async function onPaymentsSynced(customerId: string) {
  for (const p of (await PromiseModel.find({ customerId, status: 'open' }).lean()) as Lean[]) {
    const paid = await paidFor(p, today());
    if (paid >= p.promisedAmountPoisha) await closeWith(p, 'kept', paid);
    else if (paid !== (p.paidTowardsPoisha ?? 0)) {
      await PromiseModel.updateOne({ _id: p._id }, { $set: { paidTowardsPoisha: paid } });
      await touch(p);
    }
  }
}

/** FR-PRM-002: 09:00 Dhaka — one `promise.due` event per promise per day (FCM backup of the local reminder). */
export async function remindToday(): Promise<number> {
  const date = today();
  const rows = (await PromiseModel.find({ status: 'open', promisedDate: date, remindedFor: { $ne: date } }).lean()) as Lean[];
  for (const p of rows) {
    await PromiseModel.updateOne({ _id: p._id }, { $set: { remindedFor: date } });
    await ctx().bus.emit('promise.due', { promiseId: p._id.toHexString(), customerId: p.customerId, branchId: p.branchId, ownerId: p.ownerId, promisedAmountPoisha: p.promisedAmountPoisha });
  }
  return rows.length;
}

/** FR-HO-003: open promises follow the customer to the new assignee. */
export async function onHandoverAccepted(p: { toUserId: string; fromUserId: string; customerIds: string[] }) {
  const rows = (await PromiseModel.find({ customerId: { $in: p.customerIds }, status: 'open' }).lean()) as Lean[];
  for (const r of rows) {
    await PromiseModel.updateOne({ _id: r._id }, { $set: { ownerId: p.toUserId } });
    await recordChange({ entity: 'promise', entityId: r._id.toHexString(), op: 'delete', userIds: [r.ownerId], branchId: r.branchId, reason: 'handover' });
    await recordChange({ entity: 'promise', entityId: r._id.toHexString(), userIds: [p.toUserId], branchId: r.branchId });
  }
}

export async function openCount(customerIds: string[]) {
  return PromiseModel.countDocuments({ customerId: { $in: customerIds }, status: 'open' });
}

export async function openByCustomer(customerIds: string[]) {
  const rows = (await PromiseModel.find({ customerId: { $in: customerIds }, status: 'open' }).sort({ promisedDate: 1 }).lean()) as Lean[];
  const out = new Map<string, ReturnType<typeof view>>();
  for (const r of rows) if (!out.has(r.customerId)) out.set(r.customerId, view(r));
  return out;
}

/**
 * 1.24.0 (FR-CUS-017): promises of the current Dhaka month per customer. `made` = created this month (a cancelled
 * one is not counted); `kept` / `broken` = promises whose promised date is in this month and that ended that way.
 */
export async function monthByCustomer(customerIds: string[]): Promise<Map<string, { made: number; kept: number; broken: number }>> {
  const month = businessDate(ctx().clock.now()).slice(0, 7);
  const inMonth = { $gte: `${month}-01`, $lte: `${month}-31` };
  const rows = (await PromiseModel.find({ customerId: { $in: customerIds }, $or: [{ createdDate: inMonth }, { promisedDate: inMonth }] })
    .select('customerId status createdDate promisedDate')
    .lean()) as Lean[];
  const out = new Map<string, { made: number; kept: number; broken: number }>();
  for (const r of rows) {
    const x = out.get(r.customerId) ?? { made: 0, kept: 0, broken: 0 };
    if (String(r.createdDate).startsWith(month) && r.status !== 'cancelled') x.made++;
    if (String(r.promisedDate).startsWith(month)) {
      if (r.status === 'kept' || r.status === 'partially_kept') x.kept++;
      else if (r.status === 'broken') x.broken++;
    }
    out.set(r.customerId, x);
  }
  return out;
}

export async function timelineItems(customerId: string, before: Date | null, limit: number): Promise<TimelineItem[]> {
  const rows = (await PromiseModel.find({ customerId, ...(before ? { createdAt: { $lt: before } } : {}) }).sort({ createdAt: -1 }).limit(limit).lean()) as Lean[];
  return rows.map((p) => ({
    kind: 'promise',
    at: (p.createdAt as Date).toISOString(),
    summary: { en: `Promised ${formatBdt(p.promisedAmountPoisha)} by ${p.promisedDate} — ${p.status.replace(/_/g, ' ')}`, bn: `${p.promisedDate} তারিখে ${formatBdt(p.promisedAmountPoisha, 'bn')} দেওয়ার প্রতিশ্রুতি — ${p.status}` },
    refId: p._id.toHexString(),
    data: { status: p.status, promisedDate: p.promisedDate },
  }));
}

/** Dashboard counters: due on `date`, kept on `date`, broken the day before. */
export async function dayCounts(user: AuthUser, branchId: string | undefined, date: string) {
  const f = { ...scopeFilter(user), ...(branchId ? branchQuery(user, branchId) : {}) };
  const day = (d: string) => ({ $gte: new Date(`${d}T00:00:00+06:00`), $lte: new Date(`${d}T23:59:59.999+06:00`) });
  const prev = new Date(new Date(`${date}T12:00:00+06:00`).getTime() - 86_400_000).toISOString().slice(0, 10);
  const [dueToday, keptToday, brokenYesterday] = await Promise.all([
    PromiseModel.countDocuments({ ...f, promisedDate: date, status: { $in: ['open', 'kept', 'partially_kept', 'broken'] } }),
    PromiseModel.countDocuments({ ...f, status: 'kept', closedAt: day(date) }),
    PromiseModel.countDocuments({ ...f, status: 'broken', promisedDate: prev }),
  ]);
  return { dueToday, keptToday, brokenYesterday };
}

/**
 * Promises that fell due in the period, per owner (FR-PRM-004). `kept` counts fully kept promises only;
 * still-open ones are in `due` but not yet in `decided`, so the rate is not dragged down by today.
 */
export async function statsByOwner(user: AuthUser, branchId: string | undefined, from: string, to: string) {
  const rows = await PromiseModel.aggregate<{ _id: { o: string; s: string }; n: number }>([
    { $match: { ...scopeFilter(user), ...(branchId ? branchQuery(user, branchId) : {}), promisedDate: { $gte: from, $lte: to }, status: { $in: ['open', 'kept', 'partially_kept', 'broken'] } } },
    { $group: { _id: { o: '$ownerId', s: '$status' }, n: { $sum: 1 } } },
  ]);
  const out = new Map<string, { due: number; kept: number; decided: number }>();
  for (const r of rows) {
    const d = out.get(r._id.o) ?? { due: 0, kept: 0, decided: 0 };
    d.due += r.n;
    if (r._id.s === 'kept') d.kept += r.n;
    if (r._id.s !== 'open') d.decided += r.n;
    out.set(r._id.o, d);
  }
  return out;
}

export interface PromiseMatch {
  id: string;
  promisedDate: string;
  promisedAmountPoisha: number;
  status: 'open' | 'kept' | 'partially_kept' | 'broken';
  /** The collection was recorded on or before the promised date */
  onTime: boolean;
}

/**
 * FR-CASH-008: for each collection, the promise it was made against (same customer and invoice, open on that day,
 * grace of the collection's branch) and how that promise ended. `null` where no promise covered the collection.
 * Keys are the collection ids.
 */
export async function promisesBehind(
  collections: { id: string; customerId: string; erpPlanId: string | null; businessDate: string; branchId: string }[],
): Promise<Map<string, PromiseMatch | null>> {
  const out = new Map<string, PromiseMatch | null>();
  if (!collections.length) return out;
  const rows = (await PromiseModel.find({ customerId: { $in: [...new Set(collections.map((c) => c.customerId))] }, status: { $nin: ['cancelled', 'superseded'] } }).lean()) as Lean[];
  const promises = rows.map((p) => ({ id: p._id.toHexString() as string, customerId: p.customerId as string, erpPlanId: (p.erpPlanId ?? null) as string | null, createdDate: p.createdDate as string, promisedDate: p.promisedDate as string, status: p.status as string, promisedAmountPoisha: p.promisedAmountPoisha as number }));
  const grace = new Map<string, number>();
  for (const c of collections) {
    if (!grace.has(c.branchId)) grace.set(c.branchId, (await getSetting<number>('promises.graceDays', c.branchId)) ?? 1);
    const p = promiseFor(promises, c, grace.get(c.branchId)!);
    out.set(c.id, p ? { id: p.id, promisedDate: p.promisedDate, promisedAmountPoisha: p.promisedAmountPoisha, status: p.status as PromiseMatch['status'], onTime: c.businessDate <= p.promisedDate } : null);
  }
  return out;
}
