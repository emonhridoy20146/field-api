import { z } from 'zod';
import { ctx } from '../../core/context/index.js';
import { AppError, businessRule, notFound } from '../../core/errors/index.js';
import type { ClientSession } from 'mongoose';
import { isDuplicateKey, isOid, withTransaction, type LeanDoc } from '../../core/db/index.js';
import { recordChange } from '../../core/changefeed/index.js';
import { cancelPending, enqueue, hasActive } from '../../core/events/outbox.js';
import { payloadHash } from '../../core/idempotency/index.js';
import { decodeCursor, encodeCursor } from '../../core/http/index.js';
import { haversineM } from '../../core/geo/index.js';
import { formatBdt } from '../../core/money/index.js';
import { addDays, businessDate } from '../../core/time/index.js';
import { branchQuery, canSeeBranch, isSuperAdmin, type AuthUser } from '../../core/security/types.js';
import type { RequestMeta } from '../../core/http/router.js';
import * as audit from '../audit/index.js';
import { getSetting } from '../settings/index.js';
import { getBranch } from '../branches/index.js';
import { getUser, getUsers } from '../users/index.js';
import { getCustomerRef, getCustomerRefs, type MonthCollectionRef, type TimelineItem } from '../customers/index.js';
import { refreshCustomer, type ErpPayment, type PostPaymentJob, type PostPaymentResult } from '../erp-gateway/index.js';
import {
  checkReceipt,
  checkTxnRef,
  choosePlan,
  computeFlags,
  CONFLICT_TEXT,
  DEFAULT_TXN_PATTERNS,
  METHODS,
  normalizeTxnRef,
  PENDING_STATUSES,
  POSTED_STATUSES,
  RESOLVABLE,
  VOIDABLE,
  type Status,
  CASH_COUNTED_STATUSES,
  receiptPrefix,
} from './domain/rules.js';
import { CollectionModel } from './models/collection.model.js';

type Lean = LeanDoc;
const OUTBOX = 'erp.post_payment';

/** Cash position is owned by the cash module (which depends on us); it plugs in here to decorate responses. */
type CashProvider = (userId: string) => Promise<Record<string, unknown>>;
let cashProvider: CashProvider | null = null;
export const registerCashPositionProvider = (p: CashProvider) => void (cashProvider = p);

/**
 * How much of a cash collection the person's pending and verified deposits already cover (oldest-first, the same
 * rule as the cash in hand). The cash module plugs it in; until then nothing is covered.
 */
type CoverageProvider = (collectorId: string, collectionId: string) => Promise<number>;
let coverageProvider: CoverageProvider = async () => 0;
export const registerCoverageProvider = (p: CoverageProvider) => void (coverageProvider = p);

const geoFix = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0),
  mock: z.boolean().default(false),
  fixAt: z.string().datetime({ offset: true }).optional(),
});

export const createSchema = z.object({
  clientId: z.string().uuid(),
  customerId: z.string().max(64),
  erpPlanId: z.string().max(64).optional(),
  amountPoisha: z.number().int().min(1).max(100_000_000_00),
  method: z.enum(METHODS),
  transactionRef: z.string().max(60).optional(),
  payerName: z.string().max(100).optional(),
  receiptNo: z.string().max(40),
  physicalReceiptNo: z.string().max(40).optional(),
  recordedAt: z.string().datetime({ offset: true }),
  deviceTime: z.string().datetime({ offset: true }).optional(),
  // null when the phone has no fix (contract 1.2.0); never rejected, flagged `no_location`.
  geo: geoFix.nullable(),
  geoUnavailableReason: z.enum(['permission_denied', 'location_off', 'timeout', 'no_fix']).optional(),
  visitClientId: z.string().max(64).optional(),
  photoMediaId: z.string().max(64).optional(),
  note: z.string().max(500).optional(),
});
export type CollectionInput = z.infer<typeof createSchema>;

/** Fields that define "the same collection" for idempotency (FR-COL-004). */
const HASH_FIELDS = ['customerId', 'erpPlanId', 'amountPoisha', 'method', 'transactionRef', 'recordedAt'];

// ---------------- views ----------------

async function views(rows: Lean[]) {
  const refs = await getCustomerRefs(rows.map((r) => r.customerId));
  const users = await getUsers([...new Set(rows.flatMap((r) => [r.collectorId as string, r.voided?.by as string | undefined, r.edited?.by as string | undefined].filter((x): x is string => !!x)))]);
  const nameOf = (id: string) => {
    const p = users.get(id);
    return p ? p.name.en || p.name.bn : '';
  };
  return rows.map((c) => {
    const ref = refs.get(c.customerId);
    const u = users.get(c.collectorId);
    return {
      id: c._id.toHexString(),
      clientId: c.clientId,
      customer: { id: c.customerId, name: ref?.name ?? { bn: '', en: '' }, code: ref?.code ?? '' },
      erpPlanId: c.erpPlanId,
      collector: { id: c.collectorId, name: u ? u.name.en || u.name.bn : '' },
      amountPoisha: c.amountPoisha,
      method: c.method,
      transactionRef: c.transactionRef ?? null,
      receiptNo: c.receiptNo,
      erpReceiptNo: c.erp?.receiptNo ?? null,
      recordedAt: (c.recordedAt as Date).toISOString(),
      receivedAt: (c.receivedAt as Date).toISOString(),
      status: c.status as Status,
      conflict: c.conflict ? { code: c.conflict.code, message: c.conflict.message, raisedAt: (c.conflict.raisedAt as Date).toISOString() } : null,
      resolution: c.resolution ? { action: c.resolution.action, by: c.resolution.by, at: (c.resolution.at as Date).toISOString(), reason: c.resolution.reason } : null,
      flags: c.flags ?? [],
      distanceToPinM: c.geo?.distanceToPinM ?? null,
      ...(c.erp?.reversed ? { erpReversed: true } : {}),
      // 1.35.0: the deposit that handed this collection in; from then on it goes to the ERP and cannot be changed.
      depositId: (c.deposit?.id as string | undefined) ?? null,
      depositedAt: c.deposit?.at ? (c.deposit.at as Date).toISOString() : null,
      // 1.33.0: who voided it and how. Rows voided before 1.33.0 have no `kind`: the collector voiding their own is a withdrawal.
      ...(c.voided
        ? { voided: { by: c.voided.by, byName: nameOf(c.voided.by), at: (c.voided.at as Date).toISOString(), reason: c.voided.reason, kind: (c.voided.kind as string | undefined) ?? (c.voided.by === c.collectorId ? 'withdrawn' : 'admin') } }
        : {}),
      // 1.33.0: the collector corrected the amount, note or payer (the first original amount is kept).
      ...(c.edited ? { edited: { count: c.edited.count as number, at: (c.edited.at as Date).toISOString(), by: c.edited.by, byName: nameOf(c.edited.by), previousAmountPoisha: c.edited.previousAmountPoisha as number } } : {}),
    };
  });
}
const viewOne = async (c: Lean) => (await views([c]))[0]!;

// ---------------- scope ----------------

/** The write scope: field staff change only their own collections (reads use [readScope], ADR-046). */
export function scopeFilter(user: AuthUser): Record<string, unknown> {
  if (isSuperAdmin(user)) return {};
  if (user.role === 'field_staff') return { collectorId: user.id };
  return { branchId: { $in: user.branchIds } };
}

/** Who may READ a collection (FR-ACT-002, ADR-046): staff see every collection of their branches, with the collector's name. Void and resolve keep `scopeFilter`. */
export function readScope(user: AuthUser): Record<string, unknown> {
  return isSuperAdmin(user) ? {} : { branchId: { $in: user.branchIds } };
}

async function load(user: AuthUser, id: string, scope: (u: AuthUser) => Record<string, unknown> = scopeFilter): Promise<Lean> {
  if (!isOid(id)) throw notFound('collection');
  const c = (await CollectionModel.findOne({ _id: id, ...scope(user) }).lean()) as Lean | null;
  if (!c) throw notFound('collection');
  return c;
}

// ---------------- record (FR-COL-001..006, 013) ----------------

function jobFor(c: Lean, employeeId: string | null, key: string, collectorName: string | null = null): PostPaymentJob {
  const lat = c.geo?.point?.coordinates?.[1];
  const lng = c.geo?.point?.coordinates?.[0];
  return {
    collectionId: c._id.toHexString(),
    input: {
      idempotencyKey: key,
      erpCustomerId: c.erpCustomerId,
      erpPlanId: c.erpPlanId,
      erpBranchId: c.erpBranchId,
      amountPoisha: c.amountPoisha,
      method: c.method,
      transactionRef: c.transactionRef,
      collectedAt: (c.recordedAt as Date).toISOString(),
      employeeId,
      collectorName,
      fieldReceiptNo: c.receiptNo,
      physicalReceiptNo: c.physicalReceiptNo,
      note: c.note,
      fieldCollectionId: c._id.toHexString(),
      geo: lat !== undefined && lng !== undefined ? { lat, lng, accuracyM: c.geo.accuracyM } : null,
    },
  };
}

export interface RecordResult {
  statusCode: 200 | 201;
  replayed: boolean;
  body: Record<string, unknown>;
}

/**
 * Record a field collection. Same key + same payload → replay; same key + different payload → 409.
 * Business problems never reject the request: they surface later as a `conflict` (FR-COL-006).
 */
export async function record(user: AuthUser, idempotencyKey: string, input: CollectionInput, meta: RequestMeta): Promise<RecordResult> {
  const txnRef = normalizeTxnRef(input.transactionRef);
  const recordedAt = new Date(input.recordedAt);
  const hash = payloadHash({ ...input, transactionRef: txnRef, recordedAt: recordedAt.toISOString() }, HASH_FIELDS);

  const existing = (await CollectionModel.findOne({ idempotencyKey }).lean()) as Lean | null;
  if (existing) return replay(existing, hash, idempotencyKey, user);

  // Malformed input is a 400; everything else is accepted.
  const fields: { path: string; message: string }[] = [];
  const patterns = { ...DEFAULT_TXN_PATTERNS, ...((await getSetting<Record<string, string>>('collections.txnRefPatterns')) ?? {}) };
  const txnProblem = checkTxnRef(input.method, txnRef, patterns);
  if (txnProblem) fields.push({ path: 'transactionRef', message: txnProblem });
  // Branch scope, not assignment scope: a just-reassigned customer is accepted and flagged (04-architecture §7.3).
  const customer = await getCustomerRef(null, input.customerId);
  if (!customer?.branchId || !canSeeBranch(user, customer.branchId)) throw notFound('customer');
  const branch = await getBranch(customer.branchId);
  const collector = await getUser(user.id);
  if (!branch || !collector) throw notFound('customer');
  const prefix = receiptPrefix(branch.code, collector.employeeCode);
  const receiptProblem = checkReceipt(input.receiptNo, prefix);
  if (receiptProblem) fields.push({ path: 'receiptNo', message: receiptProblem });
  const plan = choosePlan(customer.plans, input.erpPlanId);
  if (!plan.ok) fields.push({ path: 'erpPlanId', message: plan.message });
  if (fields.length || !plan.ok) throw new AppError('VALIDATION_FAILED', { fields });

  const now = ctx().clock.now();
  const geo = input.geo;
  const distanceToPinM = customer.location && geo ? Math.round(haversineM(customer.location, { lat: geo.lat, lng: geo.lng })) : null;
  const duplicateTxnRef = !!txnRef && !!(await CollectionModel.exists({ method: input.method, transactionRef: txnRef, status: { $nin: ['voided', 'resolved_voided'] } }));
  const flags = computeFlags({
    distanceToPinM,
    geofenceM: (await getSetting<number>('collections.geofenceM', customer.branchId)) ?? 300,
    mock: !!geo?.mock,
    noLocation: !geo,
    recordedAt,
    deviceTime: input.deviceTime ? new Date(input.deviceTime) : null,
    receivedAt: now,
    duplicateTxnRef,
    collectorIsAssignee: customer.assigneeId === user.id || user.role !== 'field_staff',
  });

  try {
    const doc = await withTransaction(async (session) => {
      const [c] = await CollectionModel.create(
        [
          {
            clientId: input.clientId,
            idempotencyKey,
            payloadHash: hash,
            branchId: customer.branchId,
            customerId: customer.id,
            erpCustomerId: customer.erpCustomerId,
            erpBranchId: customer.erpBranchId,
            erpPlanId: plan.erpPlanId,
            collectorId: user.id,
            deviceId: meta.deviceId ?? null,
            amountPoisha: input.amountPoisha,
            method: input.method,
            transactionRef: txnRef,
            payerName: input.payerName ?? null,
            note: input.note ?? null,
            receiptNo: input.receiptNo,
            physicalReceiptNo: input.physicalReceiptNo ?? null,
            recordedAt,
            deviceTime: input.deviceTime ? new Date(input.deviceTime) : null,
            receivedAt: now,
            businessDate: businessDate(recordedAt),
            geo: geo ? { point: { type: 'Point', coordinates: [geo.lng, geo.lat] }, accuracyM: geo.accuracyM, mock: geo.mock, distanceToPinM } : null,
            geoUnavailableReason: geo ? null : (input.geoUnavailableReason ?? 'no_fix'),
            visitClientId: input.visitClientId ?? null,
            photoMediaId: input.photoMediaId ?? null,
            status: 'received',
            statusHistory: [{ status: 'received', at: now, by: user.id }],
            erp: { key: idempotencyKey, attempts: 0 },
            flags,
          },
        ],
        { session },
      );
      const lean = c!.toObject() as Lean;
      // 1.35.0 (FR-CASH-010, ADR-049): nothing goes to the ERP until the collector deposits it (`submitForDeposit`).
      await recordChange({ entity: 'collection', entityId: lean._id.toHexString(), userIds: [user.id], branchId: customer.branchId, fanoutBranchId: customer.branchId }, session);
      await audit.record(
        {
          actor: user,
          action: 'collection.received',
          entity: 'collection',
          entityId: lean._id.toHexString(),
          branchId: customer.branchId,
          after: { amountPoisha: input.amountPoisha, method: input.method, receiptNo: input.receiptNo, erpPlanId: plan.erpPlanId, flags },
          meta,
          money: true,
        },
        session,
      );
      return lean;
    });
    await ctx().bus.emit('collection.received', { collectionId: doc._id.toHexString(), branchId: doc.branchId, collectorId: user.id, customerId: doc.customerId, amountPoisha: doc.amountPoisha, method: doc.method, flags });
    return { statusCode: 201, replayed: false, body: await withCash(await viewOne(doc), user.id) };
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    const raced = (await CollectionModel.findOne({ idempotencyKey }).lean()) as Lean | null;
    if (raced) return replay(raced, hash, idempotencyKey, user);
    throw new AppError('DUPLICATE_RECEIPT_NO', { receiptNo: input.receiptNo });
  }
}

async function replay(existing: Lean, hash: string, key: string, user: AuthUser): Promise<RecordResult> {
  if (existing.payloadHash !== hash) throw new AppError('IDEMPOTENCY_MISMATCH', { idempotencyKey: key });
  if (existing.collectorId !== user.id) throw new AppError('IDEMPOTENCY_MISMATCH', { idempotencyKey: key });
  return { statusCode: 200, replayed: true, body: { ...(await withCash(await viewOne(existing), user.id)), replayed: true } };
}

async function withCash(v: Record<string, unknown>, userId: string) {
  return cashProvider ? { ...v, cashOnHand: await cashProvider(userId) } : v;
}

// ---------------- read ----------------

export const listSchema = z.object({
  branchId: z.string().max(64).optional(),
  collectorId: z.string().max(64).optional(),
  customerId: z.string().max(64).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  method: z.enum(METHODS).optional(),
  status: z.enum(['received', 'posting', 'posted', 'conflict', 'posting_failed', 'resolved_posted', 'resolved_refund', 'resolved_voided', 'voided']).optional(),
  flag: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

function filterOf(user: AuthUser, q: Partial<z.infer<typeof listSchema>>) {
  const f: Record<string, unknown> = { ...readScope(user), ...(q.branchId ? branchQuery(user, q.branchId) : {}) };
  if (q.collectorId && user.role !== 'field_staff') f.collectorId = q.collectorId;
  if (q.customerId) f.customerId = q.customerId;
  if (q.from || q.to) f.businessDate = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  if (q.method) f.method = q.method;
  if (q.status) f.status = q.status;
  if (q.flag) f.flags = q.flag;
  return f;
}

export async function list(user: AuthUser, q: z.infer<typeof listSchema>) {
  const f = filterOf(user, q);
  const cur = decodeCursor<{ at: string; id: string }>(q.cursor);
  const page = cur ? { $or: [{ recordedAt: { $lt: new Date(cur.at) } }, { recordedAt: new Date(cur.at), _id: { $lt: cur.id } }] } : {};
  const rows = (await CollectionModel.find({ ...f, ...page }).sort({ recordedAt: -1, _id: -1 }).limit(q.limit + 1).lean()) as Lean[];
  const items = rows.slice(0, q.limit);
  const last = items[items.length - 1];
  const totalsAgg = await CollectionModel.aggregate([{ $match: { ...f, status: { $nin: ['voided', 'resolved_voided', 'resolved_refund'] } } }, { $group: { _id: '$method', sum: { $sum: '$amountPoisha' } } }]);
  return {
    items: await views(items),
    nextCursor: rows.length > q.limit && last ? encodeCursor({ at: (last.recordedAt as Date).toISOString(), id: last._id.toHexString() }) : null,
    totals: Object.fromEntries(totalsAgg.map((t: { _id: string; sum: number }) => [t._id, t.sum])),
  };
}

export async function get(user: AuthUser, id: string) {
  return viewOne(await load(user, id, readScope));
}

/** Bootstrap for a fresh device: the branch's collections of the last 60 Dhaka days, paged by id (ADR-046). */
export async function syncSnapshot(user: AuthUser, cursor: string | null, limit: number) {
  const c = decodeCursor<{ id: string }>(cursor ?? undefined);
  const since = addDays(businessDate(ctx().clock.now()), -60);
  const rows = (await CollectionModel.find({ ...readScope(user), businessDate: { $gte: since }, ...(c ? { _id: { $gt: c.id } } : {}) })
    .sort({ _id: 1 })
    .limit(limit + 1)
    .lean()) as Lean[];
  const page = rows.slice(0, limit);
  return { items: await views(page), nextCursor: rows.length > limit ? encodeCursor({ id: page[page.length - 1]!._id.toHexString() }) : null };
}

export async function conflicts(user: AuthUser, q: { branchId?: string | undefined; limit: number; cursor?: string | undefined }) {
  const offset = decodeCursor<{ o: number }>(q.cursor)?.o ?? 0;
  const f = { ...scopeFilter(user), ...(q.branchId ? branchQuery(user, q.branchId) : {}), status: { $in: RESOLVABLE } };
  const rows = (await CollectionModel.find(f).sort({ 'conflict.raisedAt': 1, receivedAt: 1 }).skip(offset).limit(q.limit + 1).lean()) as Lean[];
  return { items: await views(rows.slice(0, q.limit)), nextCursor: rows.length > q.limit ? encodeCursor({ o: offset + q.limit }) : null };
}

// ---------------- void (FR-COL-009) ----------------

async function transition(c: Lean, to: Status, by: string, set: Record<string, unknown> = {}, from: Status[] = [c.status]) {
  const now = ctx().clock.now();
  const r = await CollectionModel.updateOne(
    { _id: c._id, status: { $in: from } },
    { $set: { status: to, ...set }, $push: { statusHistory: { status: to, at: now, by } }, $inc: { version: 1 } },
  );
  if (r.modifiedCount === 1) await recordChange({ entity: 'collection', entityId: c._id.toHexString(), userIds: [c.collectorId], branchId: c.branchId, fanoutBranchId: c.branchId });
  return r.modifiedCount === 1;
}

/** The server id of the caller's own collection from the clientId the app generated offline. */
export async function idByClientId(user: AuthUser, clientId: string): Promise<string> {
  const c = (await CollectionModel.findOne({ clientId, collectorId: user.id }).select({ _id: 1 }).lean()) as Lean | null;
  if (!c) throw notFound('collection');
  return c._id.toHexString();
}

/** Shared close of a collection that the ERP does not have yet: `collection.voided` (office) or `collection.withdrawn` (the collector, FR-COL-016). */
async function closeUnposted(user: AuthUser, c: Lean, reason: string, meta: RequestMeta, action: 'collection.voided' | 'collection.withdrawn') {
  const id = c._id.toHexString();
  // Stop the pending ERP post first; if a worker is posting right now we cannot know the outcome yet.
  const cancel = await cancelPending(OUTBOX, { collectionId: id });
  if (cancel === 'in_flight') throw new AppError('INVALID_STATE', { reason: 'POSTING_IN_PROGRESS' });
  const now = ctx().clock.now();
  if (!(await transition(c, 'voided', user.id, { voided: { by: user.id, at: now, reason, kind: action === 'collection.withdrawn' ? 'withdrawn' : 'admin' } }, VOIDABLE))) throw new AppError('INVALID_STATE', { reason: 'STATUS_CHANGED' });
  await audit.record({ actor: user, action, entity: 'collection', entityId: id, branchId: c.branchId, before: { status: c.status, amountPoisha: c.amountPoisha, receiptNo: c.receiptNo }, after: { status: 'voided' }, reason, meta, money: true });
  await ctx().bus.emit(action, { collectionId: id, branchId: c.branchId, collectorId: c.collectorId, customerId: c.customerId, amountPoisha: c.amountPoisha, method: c.method, byUserId: user.id, reason });
  return viewOne((await CollectionModel.findById(id).lean()) as Lean);
}

export async function voidCollection(user: AuthUser, id: string, reason: string, meta: RequestMeta) {
  const c = await load(user, id);
  if (!VOIDABLE.includes(c.status)) throw new AppError('INVALID_STATE', { reason: c.status === 'conflict' ? 'USE_RESOLVE' : 'ALREADY_POSTED_OR_CLOSED', status: c.status });
  return closeUnposted(user, c, reason, meta, 'collection.voided');
}

/**
 * A collection that is still in the collector's hand (FR-COL-016, 1.35.0 FR-CASH-010): no deposit has taken it, and for
 * cash no older deposit covers any of it either (deposits recorded before 1.35.0 cover cash oldest-first).
 */
async function assertNotDeposited(c: Lean) {
  if (c.deposit?.id) throw new AppError('INVALID_STATE', { reason: 'COVERED_BY_DEPOSIT', status: c.status });
  if (c.method === 'cash' && (await coverageProvider(c.collectorId, c._id.toHexString())) > 0) throw new AppError('INVALID_STATE', { reason: 'COVERED_BY_DEPOSIT', status: c.status });
}

/**
 * FR-COL-016: the collector deletes their own cash collection until it is deposited. Never a hard delete (ADR-018):
 * the row becomes `voided`, its receipt number stays used, and the amount leaves cash in hand and the collected totals.
 * A repeat by the same person answers with the voided collection (offline retries).
 */
export async function withdrawCollection(user: AuthUser, id: string, reason: string | undefined, meta: RequestMeta) {
  const c = await load(user, id);
  if (c.status === 'voided' && c.voided?.by === user.id) return viewOne(c);
  if (!VOIDABLE.includes(c.status)) throw new AppError('INVALID_STATE', { reason: c.status === 'conflict' ? 'USE_RESOLVE' : 'ALREADY_POSTED_OR_CLOSED', status: c.status });
  await assertNotDeposited(c);
  return closeUnposted(user, c, reason?.trim() || 'Withdrawn by the collector', meta, 'collection.withdrawn');
}

export const editSchema = z
  .object({
    amountPoisha: z.number().int().min(1).max(100_000_000_00).optional(),
    note: z.string().max(500).nullable().optional(),
    payerName: z.string().max(100).nullable().optional(),
  })
  .refine((b) => b.amountPoisha !== undefined || b.note !== undefined || b.payerName !== undefined, { message: 'nothing to change' });

/**
 * FR-COL-016: the collector corrects the amount, note or payer name of their own cash collection until it is
 * deposited. Only while the ERP has never been sent it (status `received`, no attempt): the pending post is replaced
 * with the new amount under the same ERP key. Same values again is a no-op, so an offline retry is safe.
 */
export async function editCollection(user: AuthUser, id: string, input: z.infer<typeof editSchema>, meta: RequestMeta) {
  const c = await load(user, id);
  if (c.status !== 'received' || (c.erp?.attempts ?? 0) > 0) throw new AppError('INVALID_STATE', { reason: 'NOT_EDITABLE', status: c.status });
  await assertNotDeposited(c);
  const next = {
    amountPoisha: input.amountPoisha ?? (c.amountPoisha as number),
    note: input.note === undefined ? ((c.note as string | null) ?? null) : input.note,
    payerName: input.payerName === undefined ? ((c.payerName as string | null) ?? null) : input.payerName,
  };
  const before = { amountPoisha: c.amountPoisha as number, note: (c.note as string | null) ?? null, payerName: (c.payerName as string | null) ?? null };
  if (next.amountPoisha === before.amountPoisha && next.note === before.note && next.payerName === before.payerName) return viewOne(c);
  const cancel = await cancelPending(OUTBOX, { collectionId: id });
  if (cancel === 'in_flight') throw new AppError('INVALID_STATE', { reason: 'POSTING_IN_PROGRESS' });
  await withTransaction(async (session) => {
    const edited = { count: ((c.edited?.count as number | undefined) ?? 0) + 1, at: ctx().clock.now(), by: user.id, previousAmountPoisha: (c.edited?.previousAmountPoisha as number | undefined) ?? before.amountPoisha };
    const r = await CollectionModel.updateOne({ _id: c._id, status: 'received', 'erp.attempts': { $in: [0, null] } }, { $set: { ...next, edited }, $inc: { version: 1 } }, { session });
    if (r.modifiedCount !== 1) throw new AppError('INVALID_STATE', { reason: 'STATUS_CHANGED' });
    // 1.35.0: not deposited yet, so nothing is queued for the ERP; the deposit sends the corrected amount under the same key.
    await recordChange({ entity: 'collection', entityId: id, userIds: [c.collectorId], branchId: c.branchId, fanoutBranchId: c.branchId }, session);
    await audit.record({ actor: user, action: 'collection.edited', entity: 'collection', entityId: id, branchId: c.branchId, before, after: next, meta, money: true }, session);
  });
  await ctx().bus.emit('collection.edited', { collectionId: id, branchId: c.branchId, collectorId: c.collectorId, customerId: c.customerId, amountPoisha: next.amountPoisha, previousAmountPoisha: before.amountPoisha, editCount: ((c.edited?.count as number | undefined) ?? 0) + 1, byUserId: user.id });
  return viewOne((await CollectionModel.findById(id).lean()) as Lean);
}

// ---------------- resolve (FR-COL-007) ----------------

export const resolveSchema = z.object({
  action: z.enum(['post_to_plan', 'post_as_advance', 'retry_post', 'refund', 'void']),
  erpPlanId: z.string().max(64).optional(),
  proofMediaId: z.string().max(64).optional(),
  reason: z.string().trim().min(5).max(500),
});

/**
 * Manager resolution. Re-posting uses the resolve request's own Idempotency-Key as the new ERP key
 * (the original key was already consumed by a rejection) — never a server-generated key (CLAUDE.md §2.4).
 */
export async function resolve(user: AuthUser, id: string, requestKey: string, input: z.infer<typeof resolveSchema>, meta: RequestMeta) {
  const c = await load(user, id);
  // Replay of the same resolve request: the key is already the collection's ERP key.
  if (c.resolution && c.erp?.key === requestKey) return viewOne(c);
  if (!RESOLVABLE.includes(c.status)) throw new AppError('INVALID_STATE', { reason: 'NOT_IN_CONFLICT', status: c.status });
  const now = ctx().clock.now();
  const resolution = { action: input.action, by: user.id, at: now, reason: input.reason, proofMediaId: input.proofMediaId ?? null, targetPlanId: input.erpPlanId ?? null };
  const collector = await getUser(c.collectorId);
  if (input.action === 'post_as_advance') throw businessRule('ADVANCE_NOT_SUPPORTED'); // ERP E-20 default: no advances
  if (input.action === 'refund' && !input.proofMediaId) throw businessRule('PROOF_REQUIRED');
  if (input.action === 'post_to_plan' && !input.erpPlanId) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'erpPlanId', message: 'required for post_to_plan' }] });
  if (await hasActive(OUTBOX, { collectionId: id })) throw new AppError('INVALID_STATE', { reason: 'POSTING_IN_PROGRESS' });

  await withTransaction(async (session) => {
    const set: Record<string, unknown> = { resolution };
    let to: Status;
    if (input.action === 'refund') to = 'resolved_refund';
    else if (input.action === 'void') to = 'resolved_voided';
    else {
      to = 'received';
      const planId = input.action === 'post_to_plan' ? input.erpPlanId! : c.erpPlanId;
      // retry_post keeps the original key when the original was never answered by ERP (posting_failed);
      // after an ERP rejection the payload changes (new plan) so the request's key is used.
      const key = input.action === 'retry_post' && c.status === 'posting_failed' ? c.erp.key : requestKey;
      set.erpPlanId = planId;
      set['erp.key'] = key;
      set['erp.lastError'] = null;
      set.conflict = null;
      await enqueue(OUTBOX, jobFor({ ...c, erpPlanId: planId }, collector?.erpEmployeeId ?? null, key, collector ? collector.name.en || collector.name.bn : null) as unknown as Record<string, unknown>, session);
    }
    const r = await CollectionModel.updateOne(
      { _id: c._id, status: c.status },
      { $set: { status: to, ...set }, $push: { statusHistory: { status: to, at: now, by: user.id } }, $inc: { version: 1 } },
      { session },
    );
    if (r.modifiedCount !== 1) throw new AppError('INVALID_STATE', { reason: 'STATUS_CHANGED' });
    await recordChange({ entity: 'collection', entityId: id, userIds: [c.collectorId], branchId: c.branchId, fanoutBranchId: c.branchId }, session);
    await audit.record(
      { actor: user, action: `collection.resolved.${input.action}`, entity: 'collection', entityId: id, branchId: c.branchId, before: { status: c.status, conflict: c.conflict?.code ?? null }, after: { status: to, erpPlanId: input.erpPlanId ?? c.erpPlanId }, reason: input.reason, meta, money: true },
      session,
    );
  });
  await ctx().bus.emit('collection.resolved', { collectionId: id, branchId: c.branchId, collectorId: c.collectorId, action: input.action, amountPoisha: c.amountPoisha, method: c.method });
  return viewOne((await CollectionModel.findById(id).lean()) as Lean);
}

// ---------------- ERP outcomes (events from erp-gateway) ----------------

async function byId(id: string) {
  return isOid(id) ? ((await CollectionModel.findById(id).lean()) as Lean | null) : null;
}

export async function onPosting(p: { collectionId: string; attempt: number }) {
  const c = await byId(p.collectionId);
  if (!c) return;
  await CollectionModel.updateOne({ _id: c._id }, { $set: { 'erp.attempts': p.attempt } });
  if (c.status === 'received') await transition(c, 'posting', 'system');
}

export async function onPosted(p: { collectionId: string; result: Extract<PostPaymentResult, { kind: 'posted' }> }) {
  const c = await byId(p.collectionId);
  if (!c || ['posted', 'resolved_posted'].includes(c.status)) return;
  if (['voided', 'resolved_voided', 'resolved_refund'].includes(c.status)) {
    // ERP stored it although we closed it (lost race): never hide money — raise a conflict for a manager.
    await CollectionModel.updateOne({ _id: c._id }, { $set: { 'erp.paymentId': p.result.erpPaymentId, 'erp.receiptNo': p.result.receiptNo } });
    await ctx().bus.emit('collection.posted_after_close', { collectionId: p.collectionId, branchId: c.branchId });
    return;
  }
  const to: Status = c.resolution ? 'resolved_posted' : 'posted';
  const ok = await transition(c, to, 'system', { 'erp.paymentId': p.result.erpPaymentId, 'erp.receiptNo': p.result.receiptNo, 'erp.postedAt': new Date(p.result.postedAt), 'erp.lastError': null, 'erp.deferred': false }, ['received', 'posting', 'posting_failed']);
  if (!ok) return;
  await audit.record({ actor: null, action: 'collection.posted', entity: 'collection', entityId: p.collectionId, branchId: c.branchId, after: { erpPaymentId: p.result.erpPaymentId, erpReceiptNo: p.result.receiptNo, replay: p.result.replay }, money: true });
  await ctx().bus.emit('collection.posted', { collectionId: p.collectionId, branchId: c.branchId, collectorId: c.collectorId, customerId: c.customerId, erpPlanId: c.erpPlanId, amountPoisha: c.amountPoisha });
  try {
    await refreshCustomer(c.erpCustomerId); // keep balances fresh for the app (money truth stays in ERP)
  } catch (e) {
    ctx().logger.warn({ err: (e as Error).message }, 'customer refresh after post failed');
  }
}

export async function onRejected(p: { collectionId: string; code: string; message: string; details?: unknown }) {
  const c = await byId(p.collectionId);
  if (!c) return;
  const now = ctx().clock.now();
  const ok = await transition(c, 'conflict', 'system', { conflict: { code: p.code, message: CONFLICT_TEXT[p.code] ?? { en: p.message, bn: p.message }, erpResponse: p.details ?? null, raisedAt: now }, 'erp.lastError': p.message }, ['received', 'posting', 'posting_failed']);
  if (!ok) return;
  await audit.record({ actor: null, action: 'collection.conflict', entity: 'collection', entityId: p.collectionId, branchId: c.branchId, after: { code: p.code }, money: true });
  await ctx().bus.emit('collection.conflict', { collectionId: p.collectionId, branchId: c.branchId, collectorId: c.collectorId, code: p.code, amountPoisha: c.amountPoisha });
}

export async function onRetrying(p: { collectionId: string; error: string; attempt: number }) {
  await CollectionModel.updateOne({ _id: p.collectionId }, { $set: { 'erp.lastError': p.error.slice(0, 300), 'erp.attempts': p.attempt } });
}

export async function onFailed(p: { collectionId: string; code: string; error: string }) {
  const c = await byId(p.collectionId);
  if (!c) return;
  const now = ctx().clock.now();
  const ok = await transition(c, 'posting_failed', 'system', { 'erp.lastError': p.error.slice(0, 300), conflict: { code: p.code, message: CONFLICT_TEXT[p.code] ?? { en: p.error, bn: p.error }, raisedAt: now } }, ['received', 'posting']);
  if (!ok) return;
  await audit.record({ actor: null, action: 'collection.posting_failed', entity: 'collection', entityId: p.collectionId, branchId: c.branchId, after: { code: p.code }, money: true });
  await ctx().bus.emit('collection.posting_failed', { collectionId: p.collectionId, branchId: c.branchId, collectorId: c.collectorId });
}

export async function onDeferred(p: { collectionId: string }) {
  await CollectionModel.updateOne({ _id: p.collectionId }, { $set: { 'erp.deferred': true } });
}

/** Record-only mode ended (or outbox lost an item): re-enqueue `received` collections that have no live job. */
export async function requeueStuck(): Promise<number> {
  const cutoff = new Date(ctx().clock.now().getTime() - 10 * 60_000);
  // 1.35.0: only what a deposit handed in; a collection still in hand waits for its deposit.
  const rows = (await CollectionModel.find({ status: 'received', receivedAt: { $lt: cutoff }, 'deposit.id': { $ne: null } }).limit(500).lean()) as Lean[];
  let n = 0;
  for (const c of rows) {
    if (await hasActive(OUTBOX, { collectionId: c._id.toHexString() })) continue;
    const u = await getUser(c.collectorId);
    await enqueue(OUTBOX, jobFor(c, u?.erpEmployeeId ?? null, c.erp?.key ?? c.idempotencyKey, u ? u.name.en || u.name.bn : null) as unknown as Record<string, unknown>);
    await CollectionModel.updateOne({ _id: c._id }, { $set: { 'erp.deferred': false } });
    n++;
  }
  return n;
}

/** ERP sync reports reversals of field payments (FR-COL-009): reflect, never reverse ourselves. */
export async function onPaymentsSynced(p: { customerId: string; payments: ErpPayment[] }) {
  for (const pay of p.payments) {
    if (!pay.reversed || pay.source !== 'field') continue;
    const c = (await CollectionModel.findOne({ $or: [{ 'erp.paymentId': pay.erpPaymentId }, ...(pay.idempotencyKey ? [{ 'erp.key': pay.idempotencyKey }] : [])] }).lean()) as Lean | null;
    if (!c || c.erp?.reversed) continue;
    await CollectionModel.updateOne({ _id: c._id }, { $set: { 'erp.reversed': true, 'erp.reversedAt': pay.reversedAt }, $inc: { version: 1 } });
    await recordChange({ entity: 'collection', entityId: c._id.toHexString(), userIds: [c.collectorId], branchId: c.branchId, fanoutBranchId: c.branchId });
    await audit.record({ actor: null, action: 'collection.reversed_in_erp', entity: 'collection', entityId: c._id.toHexString(), branchId: c.branchId, after: { erpPaymentId: pay.erpPaymentId }, money: true });
    await ctx().bus.emit('collection.reversed', { collectionId: c._id.toHexString(), branchId: c.branchId, collectorId: c.collectorId });
  }
}

// ---------------- helpers for other modules ----------------

/** Sums for cash positions (FR-CASH-001). */
export async function cashSums(userIds: string[], today: string) {
  const counted = ['received', 'posting', 'posted', 'conflict', 'posting_failed', 'resolved_posted'];
  const rows = await CollectionModel.aggregate([
    { $match: { collectorId: { $in: userIds }, status: { $in: counted } } },
    {
      $group: {
        _id: '$collectorId',
        cashPoisha: { $sum: { $cond: [{ $eq: ['$method', 'cash'] }, '$amountPoisha', 0] } },
        todayCashPoisha: { $sum: { $cond: [{ $and: [{ $eq: ['$method', 'cash'] }, { $eq: ['$businessDate', today] }] }, '$amountPoisha', 0] } },
        todayMobilePoisha: { $sum: { $cond: [{ $and: [{ $ne: ['$method', 'cash'] }, { $eq: ['$businessDate', today] }] }, '$amountPoisha', 0] } },
        oldestCashAt: { $min: { $cond: [{ $eq: ['$method', 'cash'] }, '$recordedAt', null] } },
      },
    },
  ]);
  return new Map<string, { cashPoisha: number; todayCashPoisha: number; todayMobilePoisha: number; oldestCashAt: Date | null }>(
    rows.map((r: { _id: string; cashPoisha: number; todayCashPoisha: number; todayMobilePoisha: number; oldestCashAt: Date | null }) => [r._id, r]),
  );
}

/**
 * 1.35.0 (FR-CASH-010): collections of mobile banking, bank or card that the collector has not handed in yet. They wait
 * on the phone like cash and go to the ERP with the next deposit. Oldest first.
 */
export async function heldNonCash(userId: string) {
  const rows = (await CollectionModel.find({ collectorId: userId, method: { $ne: 'cash' }, status: 'received', 'deposit.id': null }).sort({ recordedAt: 1, _id: 1 }).select({ _id: 1, amountPoisha: 1 }).lean()) as Lean[];
  return rows.map((r) => ({ collectionId: r._id.toHexString() as string, amountPoisha: r.amountPoisha as number }));
}

/**
 * 1.35.0 (FR-CASH-010, ADR-049): a deposit hands these collections in. Each is marked with the deposit and, if the
 * ERP does not have it yet, queued for posting under its own key, in the deposit's transaction. Answers how many were
 * taken; fewer than asked means another deposit or a void got there first, and the caller rolls back.
 */
export async function submitForDeposit(collectorId: string, depositId: string, collectionIds: string[], at: Date, session: ClientSession): Promise<number> {
  const collector = await getUser(collectorId);
  const name = collector ? collector.name.en || collector.name.bn : null;
  let taken = 0;
  for (const id of collectionIds) {
    if (!isOid(id)) continue;
    const c = (await CollectionModel.findOneAndUpdate(
      { _id: id, collectorId, 'deposit.id': null, status: { $in: CASH_COUNTED_STATUSES } },
      { $set: { deposit: { id: depositId, at } }, $inc: { version: 1 } },
      { session, new: true },
    ).lean()) as Lean | null;
    if (!c) continue;
    taken++;
    // Not posted before (still `received`): send it now. Older rows the ERP already has keep their state.
    if (c.status === 'received' && !c.erp?.paymentId && !(await hasActive(OUTBOX, { collectionId: id })))
      await enqueue(OUTBOX, jobFor(c, collector?.erpEmployeeId ?? null, c.erp?.key ?? c.idempotencyKey, name) as unknown as Record<string, unknown>, session);
    await recordChange({ entity: 'collection', entityId: id, userIds: [collectorId], branchId: c.branchId, fanoutBranchId: c.branchId }, session);
  }
  return taken;
}

/** 1.35.0: the collections a deposit handed in, cash and the rest, with where each stands in the ERP. Oldest first. */
export async function depositRows(depositId: string) {
  const rows = (await CollectionModel.find({ 'deposit.id': depositId }).sort({ recordedAt: 1, _id: 1 }).lean()) as Lean[];
  const refs = await getCustomerRefs(rows.map((r) => r.customerId));
  return rows.map((c) => ({
    collectionId: c._id.toHexString() as string,
    receiptNo: c.receiptNo as string,
    recordedAt: c.recordedAt as Date,
    businessDate: c.businessDate as string,
    customer: { id: c.customerId as string, name: refs.get(c.customerId)?.name ?? { bn: '', en: '' }, code: refs.get(c.customerId)?.code ?? '' },
    erpPlanId: c.erpPlanId as string,
    amountPoisha: c.amountPoisha as number,
    method: c.method as string,
    status: c.status as Status,
    erpReceiptNo: (c.erp?.receiptNo as string | undefined) ?? null,
    branchId: c.branchId as string,
  }));
}

/** Cash collections of a user ordered oldest first (for "oldest undeposited" after FIFO netting of deposits). */
export async function cashCollectionsOf(userId: string): Promise<{ at: Date; amountPoisha: number }[]> {
  const rows = await CollectionModel.find({ collectorId: userId, method: 'cash', status: { $in: ['received', 'posting', 'posted', 'conflict', 'posting_failed', 'resolved_posted'] } }).select('recordedAt amountPoisha').sort({ recordedAt: 1 }).lean();
  return rows.map((r) => ({ at: r.recordedAt, amountPoisha: r.amountPoisha }));
}

/**
 * FR-CASH-007: the cash collections of a user with what the reader needs to recognise them (receipt, customer,
 * invoice), oldest first. Same statuses as `cashCollectionsOf`, so the two always agree.
 */
export async function cashCollectionRows(userId: string) {
  const rows = (await CollectionModel.find({ collectorId: userId, method: 'cash', status: { $in: CASH_COUNTED_STATUSES } }).sort({ recordedAt: 1, _id: 1 }).lean()) as Lean[];
  const refs = await getCustomerRefs(rows.map((r) => r.customerId));
  return rows.map((c) => ({
    collectionId: c._id.toHexString() as string,
    receiptNo: c.receiptNo as string,
    recordedAt: c.recordedAt as Date,
    businessDate: c.businessDate as string,
    customer: { id: c.customerId as string, name: refs.get(c.customerId)?.name ?? { bn: '', en: '' }, code: refs.get(c.customerId)?.code ?? '' },
    erpPlanId: c.erpPlanId as string,
    amountPoisha: c.amountPoisha as number,
    status: c.status as Status,
    branchId: c.branchId as string,
    // 1.35.0: set once a deposit took it
    depositId: (c.deposit?.id as string | undefined) ?? null,
  }));
}

export async function pendingByCustomer(customerIds: string[]): Promise<Map<string, number>> {
  const rows = await CollectionModel.aggregate([{ $match: { customerId: { $in: customerIds }, status: { $in: PENDING_STATUSES } } }, { $group: { _id: '$customerId', sum: { $sum: '$amountPoisha' } } }]);
  return new Map(rows.map((r: { _id: string; sum: number }) => [r._id, r.sum]));
}

/** 1.24.0 (FR-CUS-017): field money recorded in the current Dhaka month that is not in the ERP yet, per customer. */
export async function monthPendingByCustomer(customerIds: string[]): Promise<Map<string, number>> {
  const from = `${businessDate(ctx().clock.now()).slice(0, 7)}-01`;
  const rows = await CollectionModel.aggregate([
    { $match: { customerId: { $in: customerIds }, status: { $in: PENDING_STATUSES }, businessDate: { $gte: from } } },
    { $group: { _id: '$customerId', sum: { $sum: '$amountPoisha' } } },
  ]);
  return new Map(rows.map((r: { _id: string; sum: number }) => [r._id, r.sum]));
}

/**
 * 1.44.0 (FR-CUS-021): field collections of the current Dhaka month per customer with their collector's name. The
 * customer row uses them to name who took each ERP payment (matched by idempotency key, CLAUDE.md §2.4) and who holds
 * the money not in the ERP yet. Voided collections are left out: they never became money.
 */
export async function monthCollectionsByCustomer(customerIds: string[]): Promise<Map<string, MonthCollectionRef[]>> {
  const from = `${businessDate(ctx().clock.now()).slice(0, 7)}-01`;
  const rows = (await CollectionModel.find({ customerId: { $in: customerIds }, businessDate: { $gte: from }, status: { $nin: ['voided', 'resolved_voided'] } })
    .select('customerId idempotencyKey collectorId amountPoisha businessDate status')
    .lean()) as Lean[];
  const users = await getUsers([...new Set(rows.map((r) => r.collectorId as string))]);
  const out = new Map<string, MonthCollectionRef[]>();
  for (const r of rows) {
    const u = users.get(r.collectorId);
    const list = out.get(r.customerId) ?? [];
    list.push({
      idempotencyKey: r.idempotencyKey,
      userId: r.collectorId,
      name: u ? u.name.en || u.name.bn : '',
      amountPoisha: r.amountPoisha,
      businessDate: r.businessDate,
      pending: (PENDING_STATUSES as string[]).includes(r.status),
    });
    out.set(r.customerId, list);
  }
  return out;
}

/** 1.29.0 (FR-CUS-019): customers with a field collection of the Dhaka month `YYYY-MM` still waiting for the ERP. */
export async function monthPendingCustomerIds(month: string): Promise<string[]> {
  const ids = await CollectionModel.distinct('customerId', { status: { $in: PENDING_STATUSES }, businessDate: { $gte: `${month}-01`, $lte: `${month}-31` } });
  return ids.map(String);
}

export async function openConflictsFor(customerIds: string[]): Promise<number> {
  return CollectionModel.countDocuments({ customerId: { $in: customerIds }, status: { $in: RESOLVABLE } });
}

export async function pendingForDetail(customerId: string) {
  const rows = (await CollectionModel.find({ customerId, status: { $in: PENDING_STATUSES } }).sort({ recordedAt: -1 }).limit(20).lean()) as Lean[];
  return views(rows);
}

export async function timelineItems(customerId: string, before: Date | null, limit: number): Promise<TimelineItem[]> {
  const rows = (await CollectionModel.find({ customerId, ...(before ? { recordedAt: { $lt: before } } : {}) }).sort({ recordedAt: -1 }).limit(limit).lean()) as Lean[];
  const users = await getUsers(rows.map((r) => r.collectorId));
  return rows.map((c) => {
    const u = users.get(c.collectorId);
    return {
      kind: 'field_collection',
      at: (c.recordedAt as Date).toISOString(),
      ...(u ? { actor: { id: u.id, name: u.name.en || u.name.bn } } : {}),
      summary: { en: `${formatBdt(c.amountPoisha)} collected (${c.method}) — ${c.status}`, bn: `${formatBdt(c.amountPoisha, 'bn')} আদায় (${c.method}) — ${c.status}` },
      refId: c._id.toHexString(),
      data: { receiptNo: c.receiptNo, status: c.status, flags: c.flags },
    };
  });
}

// ---------------- aggregates for dashboard and search ----------------

const MOBILE_METHODS = ['bkash', 'nagad', 'rocket'];

/** Collected money per Dhaka business day in the caller's scope; voided and rejected records are not counted. */
export async function collectedByDay(user: AuthUser, branchId: string | undefined, from: string, to: string) {
  const rows = await CollectionModel.aggregate<{ _id: { d: string; m: string }; s: number; n: number }>([
    { $match: { ...scopeFilter(user), ...(branchId ? branchQuery(user, branchId) : {}), businessDate: { $gte: from, $lte: to }, status: { $in: CASH_COUNTED_STATUSES } } },
    { $group: { _id: { d: '$businessDate', m: '$method' }, s: { $sum: '$amountPoisha' }, n: { $sum: 1 } } },
  ]);
  const out = new Map<string, { totalPoisha: number; cashPoisha: number; mobilePoisha: number; count: number }>();
  for (const r of rows) {
    const d = out.get(r._id.d) ?? { totalPoisha: 0, cashPoisha: 0, mobilePoisha: 0, count: 0 };
    d.totalPoisha += r.s;
    d.count += r.n;
    if (r._id.m === 'cash') d.cashPoisha += r.s;
    else if (MOBILE_METHODS.includes(r._id.m)) d.mobilePoisha += r.s;
    out.set(r._id.d, d);
  }
  return out;
}

/** Receipt search by FOS or ERP receipt number prefix (FR-SRCH-001). */
export async function searchReceipts(user: AuthUser, term: string, limit = 5) {
  const rx = new RegExp('^' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const rows = (await CollectionModel.find({ ...scopeFilter(user), $or: [{ receiptNo: rx }, { erpReceiptNo: rx }] }).sort({ _id: -1 }).limit(limit).lean()) as Lean[];
  return rows.map((c) => ({ type: 'receipt', id: c._id.toHexString(), title: c.receiptNo as string, subtitle: `${formatBdt(c.amountPoisha)} · ${c.businessDate} · ${c.status}` }));
}

/** Per-collector totals for reports (FR-REP-001): counted statuses only, amounts split by method. */
export async function collectedByUser(user: AuthUser, branchId: string | undefined, from: string, to: string) {
  const rows = await CollectionModel.aggregate<{ _id: { u: string; m: string }; s: number; n: number }>([
    { $match: { ...scopeFilter(user), ...(branchId ? branchQuery(user, branchId) : {}), businessDate: { $gte: from, $lte: to }, status: { $in: CASH_COUNTED_STATUSES } } },
    { $group: { _id: { u: '$collectorId', m: '$method' }, s: { $sum: '$amountPoisha' }, n: { $sum: 1 } } },
  ]);
  const out = new Map<string, { count: number; byMethod: Record<string, number> }>();
  for (const r of rows) {
    const d = out.get(r._id.u) ?? { count: 0, byMethod: {} };
    d.count += r.n;
    d.byMethod[r._id.m] = (d.byMethod[r._id.m] ?? 0) + r.s;
    out.set(r._id.u, d);
  }
  return out;
}

export interface CollectionReportRow {
  id: string;
  receiptNo: string;
  businessDate: string;
  recordedAt: Date;
  branchId: string;
  customerId: string;
  collectorId: string;
  amountPoisha: number;
  method: string;
  status: string;
  erpKey: string;
  erpPaymentId: string | null;
  erpReceiptNo: string | null;
}

/** Every collection of the period in scope, oldest first (exports and the reconciliation report). */
export async function collectionRows(user: AuthUser, branchId: string | undefined, from: string, to: string, limit = 50_000): Promise<CollectionReportRow[]> {
  const rows = (await CollectionModel.find({ ...scopeFilter(user), ...(branchId ? branchQuery(user, branchId) : {}), businessDate: { $gte: from, $lte: to } })
    .sort({ recordedAt: 1 })
    .limit(limit)
    .lean()) as Lean[];
  return rows.map((c) => ({
    id: c._id.toHexString(),
    receiptNo: c.receiptNo,
    businessDate: c.businessDate,
    recordedAt: c.recordedAt,
    branchId: c.branchId,
    customerId: c.customerId,
    collectorId: c.collectorId,
    amountPoisha: c.amountPoisha,
    method: c.method,
    status: c.status,
    erpKey: c.erp?.key ?? c.idempotencyKey,
    erpPaymentId: c.erp?.paymentId ?? null,
    erpReceiptNo: c.erp?.receiptNo ?? null,
  }));
}

/** One collector's counted collections of a business date, oldest first (route-history overlay). */
export async function collectionsOfUserDay(userId: string, date: string) {
  const rows = (await CollectionModel.find({ collectorId: userId, businessDate: date, status: { $in: CASH_COUNTED_STATUSES } }).sort({ recordedAt: 1 }).lean()) as Lean[];
  return rows.map((c) => ({
    id: c._id.toHexString() as string,
    customerId: c.customerId as string,
    recordedAt: c.recordedAt as Date,
    amountPoisha: c.amountPoisha as number,
    method: c.method as string,
    receiptNo: c.receiptNo as string,
    lat: (c.geo?.point?.coordinates?.[1] ?? null) as number | null,
    lng: (c.geo?.point?.coordinates?.[0] ?? null) as number | null,
  }));
}

/** Total collected on a business date per collector (live-map marker). FOS activity, not a balance. */
export async function collectedOfDay(userIds: string[], date: string): Promise<Map<string, number>> {
  const rows = await CollectionModel.aggregate<{ _id: string; s: number }>([
    { $match: { collectorId: { $in: userIds }, businessDate: date, status: { $in: CASH_COUNTED_STATUSES } } },
    { $group: { _id: '$collectorId', s: { $sum: '$amountPoisha' } } },
  ]);
  return new Map(rows.map((r) => [r._id, r.s]));
}

/**
 * FR-REP-007 collection board: money the ERP has accepted, per collector, for a period or for all time.
 * Deliberately not scoped to the caller: the board is company-wide by the owner's rule (ADR-045) and carries
 * one total per collector, never a customer or a receipt.
 */
export async function postedByCollector(q: { from?: string; to?: string; branchIds?: string[] }): Promise<Map<string, { postedPoisha: number; count: number }>> {
  const match: Record<string, unknown> = { status: { $in: POSTED_STATUSES } };
  if (q.from && q.to) match.businessDate = { $gte: q.from, $lte: q.to };
  if (q.branchIds) match.branchId = { $in: q.branchIds };
  const rows = await CollectionModel.aggregate<{ _id: string; s: number; n: number }>([{ $match: match }, { $group: { _id: '$collectorId', s: { $sum: '$amountPoisha' }, n: { $sum: 1 } } }]);
  return new Map(rows.map((r) => [r._id, { postedPoisha: r.s, count: r.n }]));
}

/** FR-REP-005 self-view: one collector's recorded money of a period, split by whether the ERP has it yet. */
export async function postedSplitOf(userId: string, from: string, to: string): Promise<{ postedPoisha: number; pendingPoisha: number }> {
  const rows = await CollectionModel.aggregate<{ _id: string; s: number }>([
    { $match: { collectorId: userId, businessDate: { $gte: from, $lte: to }, status: { $in: CASH_COUNTED_STATUSES } } },
    { $group: { _id: '$status', s: { $sum: '$amountPoisha' } } },
  ]);
  let postedPoisha = 0;
  let pendingPoisha = 0;
  for (const r of rows) {
    if ((PENDING_STATUSES as string[]).includes(r._id)) pendingPoisha += r.s;
    else postedPoisha += r.s;
  }
  return { postedPoisha, pendingPoisha };
}

/** One cell of the dashboard's collection grid: a business day × method × ERP state, counted statuses only. */
export interface CollectionDayCell {
  date: string;
  method: string;
  /** `posted` = the ERP has it (POSTED_STATUSES); `pending` = not yet in the ERP (PENDING_STATUSES). */
  erp: 'posted' | 'pending';
  amountPoisha: number;
  count: number;
}

/**
 * FR-DSH-002: counted collections of [from, to] in the caller's scope (field staff: their own, like `collectedByDay`),
 * grouped by Dhaka business day, method and whether the ERP has them. One pipeline on the indexed
 * {branchId|collectorId, businessDate, status}; the dashboard folds the cells into today / month / range / series /
 * method figures, so the numbers always add up to each other.
 */
export async function collectionDayCells(user: AuthUser, branchId: string | undefined, from: string, to: string): Promise<CollectionDayCell[]> {
  const rows = await CollectionModel.aggregate<{ _id: { d: string; m: string; p: boolean }; s: number; n: number }>([
    { $match: { ...scopeFilter(user), ...(branchId ? branchQuery(user, branchId) : {}), businessDate: { $gte: from, $lte: to }, status: { $in: CASH_COUNTED_STATUSES } } },
    { $group: { _id: { d: '$businessDate', m: '$method', p: { $in: ['$status', PENDING_STATUSES] } }, s: { $sum: '$amountPoisha' }, n: { $sum: 1 } } },
  ]);
  return rows.map((r) => ({ date: r._id.d, method: r._id.m, erp: r._id.p ? 'pending' : 'posted', amountPoisha: r.s, count: r.n }));
}
