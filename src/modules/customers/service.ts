import { ctx } from '../../core/context/index.js';
import { AppError, businessRule, notFound } from '../../core/errors/index.js';
import { isDuplicateKey, isOid, type LeanDoc, type LooseObject } from '../../core/db/index.js';
import { recordChange, recordChanges, type ChangeInput } from '../../core/changefeed/index.js';
import { classifyCoords, haversineM, parseBbox, type LatLng } from '../../core/geo/index.js';
import { decodeCursor, encodeCursor } from '../../core/http/index.js';
import { formatBdt } from '../../core/money/index.js';
import { businessDate } from '../../core/time/index.js';
import { branchQuery, isSuperAdmin, type AuthUser } from '../../core/security/types.js';
import type { RequestMeta } from '../../core/http/router.js';
import * as audit from '../audit/index.js';
import { getByErpBranchId } from '../branches/index.js';
import { getUsers } from '../users/index.js';
import { refreshCustomer as erpRefresh, ErpUnavailableError, type ErpCustomer } from '../erp-gateway/index.js';
import { badges, deriveCustomer, worstStatus, type CustomerStatus } from './domain/status.js';
import { CustomerModel, LocationProposalModel } from './models/customer.model.js';

type Doc = LeanDoc;
const today = () => businessDate(ctx().clock.now());

// ---------------- extension points (inversion of control, no import cycles) ----------------

export interface ListExtras {
  openPromise?: Record<string, unknown> | null;
  lastVisitAt?: string | null;
  pendingFieldPoisha?: number;
  areaName?: { bn: string; en: string } | null;
}
export type ListEnricher = (customerIds: string[], user: AuthUser) => Promise<Map<string, ListExtras>>;
export type DetailContributor = (
  customer: { id: string; erpCustomerId: string; branchId: string | null },
  user: AuthUser,
) => Promise<Record<string, unknown>>;
export interface TimelineItem {
  kind: string;
  at: string;
  actor?: { id: string; name: string };
  summary: { bn: string; en: string };
  refId?: string;
  data?: Record<string, unknown>;
}
export type TimelineSource = (
  customerId: string,
  user: AuthUser,
  before: Date | null,
  limit: number,
) => Promise<TimelineItem[]>;

const enrichers: ListEnricher[] = [];
const contributors: DetailContributor[] = [];
const timelineSources: TimelineSource[] = [];
export const registerListEnricher = (e: ListEnricher) => void enrichers.push(e);
export const registerDetailContributor = (c: DetailContributor) => void contributors.push(c);
export const registerTimelineSource = (s: TimelineSource) => void timelineSources.push(s);

// ---------------- scope (CLAUDE.md §2.7, 04-architecture §6.2) ----------------

/** SA → all; field staff → their assigned customers; BM/viewer → their branches. */
export function scopeFilter(user: AuthUser): Record<string, unknown> {
  if (isSuperAdmin(user)) return {};
  if (user.role === 'field_staff') return { 'fos.assigneeId': user.id, branchId: { $in: user.branchIds } };
  return { branchId: { $in: user.branchIds } };
}

async function loadInScope(user: AuthUser, id: string): Promise<Doc> {
  if (!isOid(id)) throw notFound('customer');
  const c = (await CustomerModel.findOne({ _id: id, ...scopeFilter(user) }).lean()) as Doc | null;
  if (!c) throw notFound('customer'); // out of scope → 404 (ADR-022)
  return c;
}

export async function inScope(user: AuthUser, id: string): Promise<boolean> {
  if (!isOid(id)) return false;
  return !!(await CustomerModel.exists({ _id: id, ...scopeFilter(user) }));
}

/** Minimal facts other modules need; null if missing or out of scope. */
export interface CustomerRef {
  id: string;
  erpCustomerId: string;
  erpBranchId: string;
  branchId: string | null;
  code: string;
  name: { bn: string; en: string };
  assigneeId: string | null;
  areaId: string | null;
  location: LatLng | null;
  erpStatus: string;
  totalOutstandingPoisha: number;
  overdue: boolean;
  daysOverdue: number;
  badSuggested: boolean;
  tagged: boolean;
  /** Current FOS tag overlay (owned by the tags module), or null. */
  tag: Record<string, unknown> | null;
  plans: { erpPlanId: string; status: string; outstandingPoisha: number; product: string }[];
}

function ref(c: Doc): CustomerRef {
  return {
    id: c._id.toHexString(),
    erpCustomerId: c.erpCustomerId,
    erpBranchId: c.erpBranchId,
    branchId: c.branchId ?? null,
    code: c.code ?? '',
    name: { bn: c.name?.bn ?? '', en: c.name?.en ?? '' },
    assigneeId: c.fos?.assigneeId ?? null,
    areaId: c.fos?.areaId ?? null,
    location:
      c.location?.coordinates?.length === 2 ? { lat: c.location.coordinates[1], lng: c.location.coordinates[0] } : null,
    erpStatus: c.erpStatus,
    totalOutstandingPoisha: c.derived?.totalOutstandingPoisha ?? 0,
    overdue: !!c.derived?.overdue,
    daysOverdue: c.derived?.daysOverdue ?? 0,
    badSuggested: !!c.derived?.badSuggested,
    tagged: c.fos?.tag?.state === 'tagged',
    tag: c.fos?.tag ?? null,
    plans: (c.plans ?? []).map((p: LooseObject) => ({
      erpPlanId: p.erpPlanId,
      status: p.status,
      outstandingPoisha: p.outstandingPoisha,
      product: p.product,
    })),
  };
}

export async function getCustomerRef(user: AuthUser | null, id: string): Promise<CustomerRef | null> {
  if (!isOid(id)) return null;
  const c = (await CustomerModel.findOne({ _id: id, ...(user ? scopeFilter(user) : {}) }).lean()) as Doc | null;
  return c ? ref(c) : null;
}

export async function getCustomerRefs(ids: string[]): Promise<Map<string, CustomerRef>> {
  const rows = (await CustomerModel.find({ _id: { $in: [...new Set(ids)].filter(isOid) } }).lean()) as Doc[];
  return new Map(rows.map((r) => [r._id.toHexString(), ref(r)]));
}

export async function getByErpId(erpCustomerId: string): Promise<CustomerRef | null> {
  const c = (await CustomerModel.findOne({ erpCustomerId }).lean()) as Doc | null;
  return c ? ref(c) : null;
}

/** Ids of customers in a branch matching ERP area codes and/or inside a GeoJSON polygon (assignments). */
export async function idsInArea(
  branchId: string,
  q: { areaCodes?: string[]; polygon?: Record<string, unknown> | null },
): Promise<string[]> {
  const ors: Record<string, unknown>[] = [];
  if (q.areaCodes?.length) ors.push({ areaCode: { $in: q.areaCodes } });
  if (q.polygon) ors.push({ location: { $geoWithin: { $geometry: q.polygon } } });
  if (!ors.length) return [];
  const rows = await CustomerModel.find({ branchId, $or: ors }).select('_id').lean();
  return rows.map((r) => r._id.toHexString());
}

/** Current denormalized assignment of every customer in a branch (assignments recompute). */
export async function assignmentStateOfBranch(
  branchId: string,
): Promise<{ id: string; assigneeId: string | null; areaId: string | null }[]> {
  const rows = (await CustomerModel.find({ branchId }).select('_id fos.assigneeId fos.areaId').lean()) as Doc[];
  return rows.map((r) => ({
    id: r._id.toHexString(),
    assigneeId: r.fos?.assigneeId ?? null,
    areaId: r.fos?.areaId ?? null,
  }));
}

/** Sum of non-reversed ERP payments on a plan between two business dates (promise evaluation). Display/evaluation only. */
export async function erpPaidBetween(
  customerId: string,
  erpPlanId: string | null,
  from: string,
  to: string,
): Promise<number> {
  if (!isOid(customerId)) return 0;
  const c = (await CustomerModel.findById(customerId).select('recentPayments').lean()) as Doc | null;
  let sum = 0;
  for (const p of (c?.recentPayments ?? []) as LooseObject[])
    if (!p.reversed && p.date >= from && p.date <= to && (!erpPlanId || !p.erpPlanId || p.erpPlanId === erpPlanId))
      sum += p.amountPoisha;
  return sum;
}

export async function idsAssignedTo(userId: string): Promise<string[]> {
  return (await CustomerModel.find({ 'fos.assigneeId': userId }).select('_id').lean()).map((r) => r._id.toHexString());
}

// ---------------- ERP sync → read model ----------------

function locationFields(c: ErpCustomer, override: LooseObject | null) {
  if (override?.point) return { location: override.point, locationStatus: 'overridden', locationSource: 'overlay' };
  const status = classifyCoords(c.lat, c.lng);
  return {
    location: status === 'ok' ? { type: 'Point', coordinates: [c.lng!, c.lat!] } : undefined,
    locationStatus: status,
    locationSource: 'erp',
  };
}

function derivedFor(plans: ErpCustomer['plans'], date: string) {
  const d = deriveCustomer(plans, date);
  return { ...d, computedFor: date };
}

/** Upsert one customer from an ERP sync event. Emits balance_cleared and change-feed entries. */
export async function upsertFromErp(c: ErpCustomer, fetchedAt: Date): Promise<string | null> {
  const branch = await getByErpBranchId(c.erpBranchId);
  if (!branch) {
    ctx().logger.warn({ erpBranchId: c.erpBranchId }, 'customer for unknown branch skipped');
    return null;
  }
  const prev = (await CustomerModel.findOne({ erpCustomerId: c.erpCustomerId }).lean()) as Doc | null;
  const loc = locationFields(c, prev?.fos?.locationOverride ?? null);
  const derived = derivedFor(c.plans, today());
  const set: Record<string, unknown> = {
    branchId: branch.id,
    erpBranchId: c.erpBranchId,
    code: c.code,
    name: c.name,
    phones: c.phones,
    guarantor: c.guarantor,
    address: c.address,
    areaCode: c.areaCode,
    erpLocation: c.lat !== null && c.lng !== null ? { lat: c.lat, lng: c.lng } : null,
    locationStatus: loc.locationStatus,
    locationSource: loc.locationSource,
    plans: c.plans,
    recentPayments: c.recentPayments,
    derived,
    erpStatus: c.status,
    erpUpdatedAt: c.updatedAt,
    erpFetchedAt: fetchedAt,
  };
  const update: Record<string, unknown> = { $set: set, $inc: { version: 1 } };
  if (loc.location) set.location = loc.location;
  else update.$unset = { location: 1 };
  const doc = (await CustomerModel.findOneAndUpdate({ erpCustomerId: c.erpCustomerId }, update, {
    upsert: true,
    new: true,
  }).lean()) as Doc;
  const id = doc._id.toHexString();
  const prevTotal = prev?.derived?.totalOutstandingPoisha ?? null;
  if (prevTotal !== null && prevTotal > 0 && derived.totalOutstandingPoisha === 0)
    await ctx().bus.emit('customer.balance_cleared', {
      customerId: id,
      branchId: branch.id,
      tagged: doc.fos?.tag?.state === 'tagged',
    });
  const areaChanged =
    !prev ||
    prev.areaCode !== c.areaCode ||
    JSON.stringify(prev.location ?? null) !== JSON.stringify(doc.location ?? null) ||
    prev.branchId !== branch.id;
  if (areaChanged)
    await ctx().bus.emit('customer.placed', {
      customerId: id,
      branchId: branch.id,
      areaCode: c.areaCode,
      isNew: !prev,
    });
  await ctx().bus.emit('customer.payments_synced', { customerId: id, payments: c.recentPayments });
  if (doc.fos?.assigneeId)
    await recordChange({ entity: 'customer', entityId: id, userIds: [doc.fos.assigneeId], branchId: branch.id });
  return id;
}

/** Reconcile: customers not returned by ERP for a branch are marked missing (never deleted). */
export async function markMissing(erpBranchId: string, seen: string[]): Promise<number> {
  const r = await CustomerModel.updateMany(
    { erpBranchId, erpCustomerId: { $nin: seen }, erpStatus: { $ne: 'missing' } },
    { $set: { erpStatus: 'missing' } },
  );
  return r.modifiedCount;
}

/** Nightly (00:05 Dhaka): dates move even when data does not, so re-derive status for everyone. */
export async function recomputeAllDerived(): Promise<number> {
  const date = today();
  let n = 0;
  const cursor = CustomerModel.find({ 'derived.computedFor': { $ne: date } })
    .lean()
    .cursor();
  for await (const c of cursor as AsyncIterable<Doc>) {
    const prevBad = !!c.derived?.badSuggested;
    const derived = derivedFor(c.plans ?? [], date);
    await CustomerModel.updateOne({ _id: c._id }, { $set: { derived }, $inc: { version: 1 } });
    if (
      c.fos?.assigneeId &&
      (prevBad !== derived.badSuggested ||
        c.derived?.overdue !== derived.overdue ||
        c.derived?.dueToday !== derived.dueToday)
    )
      await recordChange({
        entity: 'customer',
        entityId: c._id.toHexString(),
        userIds: [c.fos.assigneeId],
        branchId: c.branchId,
      });
    n++;
  }
  return n;
}

// ---------------- FOS overlay updates (from other modules' events) ----------------

export interface AssignmentChange {
  customerId: string;
  assigneeId: string | null;
  areaId?: string | null;
}

/** assignment.changed → denormalize primary assignee; tombstone to old device, upsert to new. */
export async function applyAssignments(changes: AssignmentChange[]): Promise<void> {
  const feed: ChangeInput[] = [];
  for (const ch of changes) {
    if (!isOid(ch.customerId)) continue;
    const prev = (await CustomerModel.findById(ch.customerId).select('fos branchId').lean()) as Doc | null;
    if (!prev) continue;
    const before = prev.fos?.assigneeId ?? null;
    const set: Record<string, unknown> = { 'fos.assigneeId': ch.assigneeId };
    if (ch.areaId !== undefined) set['fos.areaId'] = ch.areaId;
    await CustomerModel.updateOne({ _id: ch.customerId }, { $set: set, $inc: { version: 1 } });
    if (before && before !== ch.assigneeId)
      feed.push({
        entity: 'customer',
        entityId: ch.customerId,
        op: 'delete',
        userIds: [before],
        branchId: prev.branchId,
        reason: 'unassigned',
      });
    if (ch.assigneeId)
      feed.push({ entity: 'customer', entityId: ch.customerId, userIds: [ch.assigneeId], branchId: prev.branchId });
  }
  await recordChanges(feed);
}

export async function setTag(customerId: string, tag: Record<string, unknown> | null): Promise<void> {
  if (!isOid(customerId)) return;
  const c = (await CustomerModel.findByIdAndUpdate(
    customerId,
    { $set: { 'fos.tag': tag }, $inc: { version: 1 } },
    { new: true },
  ).lean()) as Doc | null;
  if (c?.fos?.assigneeId)
    await recordChange({ entity: 'customer', entityId: customerId, userIds: [c.fos.assigneeId], branchId: c.branchId });
}

export async function setOpenPromiseDates(customerId: string, dates: string[]): Promise<void> {
  if (!isOid(customerId)) return;
  await CustomerModel.updateOne({ _id: customerId }, { $set: { 'fos.openPromiseDates': dates } });
}

/** Version of the customer document (for If-Match on tag edits). */
export async function customerVersion(id: string): Promise<number | null> {
  if (!isOid(id)) return null;
  return ((await CustomerModel.findById(id).select('version').lean()) as Doc | null)?.version ?? null;
}

// ---------------- views ----------------

function locationView(c: Doc) {
  const coords = c.location?.coordinates;
  const show = (c.locationStatus === 'ok' || c.locationStatus === 'overridden') && coords?.length === 2;
  return {
    lat: show ? coords[1] : null,
    lng: show ? coords[0] : null,
    status: c.locationStatus ?? 'missing',
    source: c.locationSource ?? 'erp',
  };
}

/** Contract Tag from the overlay the tags module writes (same rule as tags/domain view()). */
function tagView(c: Doc) {
  const t = c.fos?.tag;
  if (!t || (t.state !== 'tagged' && !t.pendingEventId)) return { state: 'none' };
  if (t.state !== 'tagged') return { state: 'pending' };
  const out: Record<string, unknown> = { state: 'tagged' };
  for (const k of ['severity', 'reasonCode', 'reason', 'setBy']) if (t[k]) out[k] = t[k];
  if (t.setAt) out.setAt = new Date(t.setAt).toISOString();
  return out;
}

function statusBadges(c: Doc, date: string): CustomerStatus[] {
  return badges(
    {
      overdue: !!c.derived?.overdue,
      dueToday: !!c.derived?.dueToday,
      badSuggested: !!c.derived?.badSuggested,
      totalOutstandingPoisha: c.derived?.totalOutstandingPoisha ?? 0,
    },
    { promisedToday: (c.fos?.openPromiseDates ?? []).includes(date), tagged: c.fos?.tag?.state === 'tagged' },
  );
}

async function listItems(rows: Doc[], user: AuthUser, near: LatLng | null) {
  const ids = rows.map((r) => r._id.toHexString());
  const date = today();
  const assignees = await getUsers(rows.map((r) => r.fos?.assigneeId).filter(Boolean));
  const extras = new Map<string, ListExtras>();
  for (const e of enrichers) {
    const m = await e(ids, user);
    for (const [k, v] of m) extras.set(k, { ...extras.get(k), ...v });
  }
  return rows.map((c) => {
    const id = c._id.toHexString();
    const loc = locationView(c);
    const x = extras.get(id) ?? {};
    const a = c.fos?.assigneeId ? assignees.get(c.fos.assigneeId) : undefined;
    return {
      id,
      erpCustomerId: c.erpCustomerId,
      code: c.code ?? '',
      name: { bn: c.name?.bn ?? '', en: c.name?.en ?? '' },
      phone: c.phones?.[0] ?? '',
      address: c.address ?? '',
      location: loc,
      distanceM: near && loc.lat !== null ? Math.round(haversineM(near, { lat: loc.lat, lng: loc.lng })) : null,
      totalOutstandingPoisha: c.derived?.totalOutstandingPoisha ?? 0,
      nextDueDate: c.derived?.nextDueDate ?? null,
      daysOverdue: c.derived?.daysOverdue ?? 0,
      badges: statusBadges(c, date),
      tag: tagView(c),
      openPromise: x.openPromise ?? null,
      lastVisitAt: x.lastVisitAt ?? null,
      pendingFieldPoisha: x.pendingFieldPoisha ?? 0,
      installmentPoisha: c.derived?.nextInstallmentPoisha ?? null,
      overduePoisha: c.derived?.overdueAmountPoisha ?? 0,
      areaName: x.areaName ?? null,
      ...(a ? { assignee: { id: a.id, name: a.name.en || a.name.bn } } : {}),
      erpFetchedAt: (c.erpFetchedAt as Date).toISOString(),
    };
  });
}

export interface ListQuery {
  filter: string[];
  assignedTo?: string;
  branchId?: string;
  areaId?: string;
  q?: string;
  near?: LatLng | null;
  radiusM: number;
  sort?: string;
  limit: number;
  cursor?: string;
  includeTotal?: boolean;
}

const STATUS_FILTERS: Record<string, (date: string) => Record<string, unknown>> = {
  overdue: () => ({ 'derived.overdue': true }),
  due_today: () => ({ 'derived.dueToday': true }),
  promised_today: (d) => ({ 'fos.openPromiseDates': d }),
  bad_suggested: () => ({ 'derived.badSuggested': true }),
  tagged_bad: () => ({ 'fos.tag.state': 'tagged' }),
  paid_up: () => ({ 'derived.totalOutstandingPoisha': 0 }),
  no_location: () => ({ locationStatus: { $nin: ['ok', 'overridden'] } }),
  unassigned: () => ({ 'fos.assigneeId': null }),
};

function buildFilter(user: AuthUser, q: ListQuery): Record<string, unknown> {
  const and: Record<string, unknown>[] = [scopeFilter(user)];
  if (q.branchId) and.push(branchQuery(user, q.branchId));
  // Status filters combine with OR ("due today or overdue"); other params narrow with AND.
  const ors = q.filter.filter((f) => STATUS_FILTERS[f]).map((f) => STATUS_FILTERS[f]!(today()));
  if (ors.length) and.push({ $or: ors });
  if (q.assignedTo) and.push({ 'fos.assigneeId': q.assignedTo === 'me' ? user.id : q.assignedTo });
  if (q.areaId) and.push({ 'fos.areaId': q.areaId });
  if (q.q) {
    const term = q.q.trim();
    const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const digits = term.replace(/\D/g, '');
    and.push({
      $or: [
        { 'name.en': rx },
        { 'name.bn': rx },
        { code: rx },
        { erpCustomerId: term },
        ...(digits.length >= 4 ? [{ phones: { $regex: digits.slice(-10) } }] : []),
      ],
    });
  }
  if (q.near)
    and.push({ location: { $geoWithin: { $centerSphere: [[q.near.lng, q.near.lat], q.radiusM / 6378100] } } });
  return { $and: and };
}

const SORTS: Record<string, Record<string, 1 | -1>> = {
  '-daysOverdue': { 'derived.daysOverdue': -1, _id: 1 },
  name: { 'name.en': 1, _id: 1 },
  '-totalOutstanding': { 'derived.totalOutstandingPoisha': -1, _id: 1 },
  nextDueDate: { 'derived.nextDueDate': 1, _id: 1 },
};

/** Offset cursor: lists are scoped and small (≤ a few thousand per user); documented in 05-api-contract. */
export async function list(user: AuthUser, q: ListQuery) {
  const filter = buildFilter(user, q);
  const offset = decodeCursor<{ o: number }>(q.cursor)?.o ?? 0;
  let rows: Doc[];
  let hasMore: boolean;
  if (q.sort === 'distance') {
    if (!q.near)
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ path: 'near', message: 'near is required for sort=distance' }],
      });
    const all = (await CustomerModel.find(filter).limit(2000).lean()) as Doc[];
    const near = q.near;
    all.sort(
      (a, b) =>
        haversineM(near, { lat: a.location.coordinates[1], lng: a.location.coordinates[0] }) -
        haversineM(near, { lat: b.location.coordinates[1], lng: b.location.coordinates[0] }),
    );
    rows = all.slice(offset, offset + q.limit);
    hasMore = all.length > offset + q.limit;
  } else {
    const found = (await CustomerModel.find(filter)
      .sort(SORTS[q.sort ?? '-daysOverdue'] ?? SORTS['-daysOverdue']!)
      .skip(offset)
      .limit(q.limit + 1)
      .lean()) as Doc[];
    hasMore = found.length > q.limit;
    rows = found.slice(0, q.limit);
  }
  return {
    items: await listItems(rows, user, q.near ?? null),
    nextCursor: hasMore ? encodeCursor({ o: offset + q.limit }) : null,
    ...(q.includeTotal ? { total: await CustomerModel.countDocuments(filter).limit(10_000) } : {}),
  };
}

function planView(p: LooseObject, d: LooseObject | undefined) {
  return {
    erpPlanId: p.erpPlanId,
    product: p.product ?? '',
    ...(p.startDate ? { startDate: p.startDate } : {}),
    ...(d?.finalDueDate ? { finalDueDate: d.finalDueDate } : {}),
    ...(p.installmentCount != null ? { installmentCount: p.installmentCount } : {}),
    totalPayablePoisha: p.totalPayablePoisha ?? 0,
    downPaymentPoisha: p.downPaymentPoisha ?? 0,
    paidPoisha: p.paidPoisha ?? 0,
    outstandingPoisha: p.outstandingPoisha ?? 0,
    status: p.status,
    badSuggested: !!d?.badSuggested,
    schedule: (d?.lines ?? []).map((l: LooseObject) => ({
      seq: l.seq,
      dueDate: l.dueDate,
      amountPoisha: l.amountPoisha,
      paidPoisha: l.paidPoisha,
      status: l.status,
      estimated: l.estimated,
    })),
  };
}

function fmtDate(d: string, lang: 'bn' | 'en') {
  return new Date(`${d}T00:00:00+06:00`).toLocaleDateString(lang === 'bn' ? 'bn-BD' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Dhaka',
  });
}

async function detailOf(c: Doc, user: AuthUser) {
  const [item] = await listItems([c], user, null);
  const dPlans = new Map<string, LooseObject>(
    (c.derived?.plans ?? []).map((p: LooseObject) => [p.erpPlanId, p]),
  );
  const br = c.derived?.badReason as { erpPlanId: string; finalDueDate: string; outstandingPoisha: number } | null;
  const extra: Record<string, unknown> = { pendingCollections: [], recentNotes: [], lastVisit: null };
  for (const contrib of contributors)
    Object.assign(
      extra,
      await contrib({ id: c._id.toHexString(), erpCustomerId: c.erpCustomerId, branchId: c.branchId }, user),
    );
  return {
    ...item!,
    phones: c.phones ?? [],
    ...(c.guarantor ? { guarantor: c.guarantor } : {}),
    plans: (c.plans ?? []).map((p: LooseObject) => planView(p, dPlans.get(p.erpPlanId))),
    payments: (c.recentPayments ?? []).map((p: LooseObject) => ({
      erpPaymentId: p.erpPaymentId,
      date: p.date,
      amountPoisha: p.amountPoisha,
      method: p.method,
      source: p.source,
      receiptNo: p.receiptNo ?? '',
      reversed: !!p.reversed,
    })),
    badSuggestion: br
      ? {
          ...br,
          text: {
            en: `Plan ended ${fmtDate(br.finalDueDate, 'en')}, ${formatBdt(br.outstandingPoisha)} outstanding`,
            bn: `কিস্তির মেয়াদ শেষ ${fmtDate(br.finalDueDate, 'bn')}, বাকি ${formatBdt(br.outstandingPoisha, 'bn')}`,
          },
        }
      : null,
    ...extra,
    version: c.version ?? 1,
  };
}

export async function detail(user: AuthUser, id: string) {
  return detailOf(await loadInScope(user, id), user);
}

/** For sync: list-item + plans + recent notes for the mobile local DB. */
export async function syncLoad(ids: string[], user: AuthUser): Promise<Map<string, Record<string, unknown>>> {
  const rows = (await CustomerModel.find({ _id: { $in: ids.filter(isOid) }, ...scopeFilter(user) }).lean()) as Doc[];
  const out = new Map<string, Record<string, unknown>>();
  for (const r of rows) out.set(r._id.toHexString(), await detailOf(r, user));
  return out;
}

export async function syncSnapshot(user: AuthUser, cursor: string | null, limit: number) {
  const c = decodeCursor<{ id: string }>(cursor ?? undefined);
  const rows = (await CustomerModel.find({ ...scopeFilter(user), ...(c ? { _id: { $gt: c.id } } : {}) })
    .sort({ _id: 1 })
    .limit(limit + 1)
    .lean()) as Doc[];
  const page = rows.slice(0, limit);
  const items: Record<string, unknown>[] = [];
  for (const r of page) items.push(await detailOf(r, user));
  return {
    items,
    nextCursor: rows.length > limit ? encodeCursor({ id: page[page.length - 1]!._id.toHexString() }) : null,
  };
}

export async function timeline(user: AuthUser, id: string, limit: number, cursor?: string) {
  const c = await loadInScope(user, id);
  const before = decodeCursor<{ before: string }>(cursor)?.before ?? null;
  const beforeDate = before ? new Date(before) : null;
  const items: TimelineItem[] = [];
  for (const p of (c.recentPayments ?? []) as LooseObject[]) {
    const at = new Date(`${p.date}T12:00:00+06:00`);
    if (beforeDate && at >= beforeDate) continue;
    items.push({
      kind: 'erp_payment',
      at: at.toISOString(),
      summary: {
        en: `${formatBdt(p.amountPoisha)} paid (${p.source}${p.reversed ? ', reversed' : ''})`,
        bn: `${formatBdt(p.amountPoisha, 'bn')} পরিশোধ (${p.source === 'office' ? 'অফিস' : 'মাঠ'}${p.reversed ? ', বাতিল' : ''})`,
      },
      refId: p.erpPaymentId,
      data: { receiptNo: p.receiptNo, method: p.method, reversed: !!p.reversed },
    });
  }
  const proposals = await LocationProposalModel.find({
    customerId: id,
    status: 'approved',
    ...(beforeDate ? { decidedAt: { $lt: beforeDate } } : {}),
  })
    .sort({ decidedAt: -1 })
    .limit(limit)
    .lean();
  for (const p of proposals)
    items.push({
      kind: 'location_correction',
      at: p.decidedAt!.toISOString(),
      summary: { en: 'Map pin corrected', bn: 'ম্যাপ পিন সংশোধন' },
      refId: p._id.toHexString(),
    });
  for (const src of timelineSources) items.push(...(await src(id, user, beforeDate, limit)));
  items.sort((a, b) => b.at.localeCompare(a.at));
  const page = items.slice(0, limit);
  return { items: page, nextCursor: items.length > limit ? encodeCursor({ before: page[page.length - 1]!.at }) : null };
}

export async function map(user: AuthUser, q: { bbox: string; zoom?: number; filter: string[]; branchId?: string }) {
  const box = parseBbox(q.bbox);
  if (!box)
    throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'bbox', message: 'minLng,minLat,maxLng,maxLat' }] });
  const filter = buildFilter(user, {
    filter: q.filter,
    radiusM: 0,
    limit: 0,
    ...(q.branchId ? { branchId: q.branchId } : {}),
  });
  (filter.$and as Record<string, unknown>[]).push({
    location: {
      $geoWithin: {
        $box: [
          [box.minLng, box.minLat],
          [box.maxLng, box.maxLat],
        ],
      },
    },
  });
  const rows = (await CustomerModel.find(filter).select('name location derived fos').limit(5000).lean()) as Doc[];
  const date = today();
  const pins = rows.map((c) => ({
    id: c._id.toHexString(),
    lat: c.location.coordinates[1] as number,
    lng: c.location.coordinates[0] as number,
    status: worstStatus(statusBadges(c, date)),
    name: c.name?.bn || c.name?.en || '',
    outstandingPoisha: c.derived?.totalOutstandingPoisha ?? 0,
    tagged: c.fos?.tag?.state === 'tagged',
  }));
  if ((q.zoom ?? 15) >= 13 && pins.length <= 2000) return { pins, clusters: [] };
  // Grid clustering: cell ≈ 1/8 of a tile at this zoom.
  const cell = 360 / 2 ** (q.zoom ?? 10) / 8;
  const cells = new Map<string, { lat: number; lng: number; count: number; statuses: CustomerStatus[] }>();
  for (const p of pins) {
    const k = `${Math.floor(p.lat / cell)}:${Math.floor(p.lng / cell)}`;
    const g = cells.get(k) ?? { lat: 0, lng: 0, count: 0, statuses: [] };
    g.lat += p.lat;
    g.lng += p.lng;
    g.count++;
    g.statuses.push(p.status);
    cells.set(k, g);
  }
  return {
    pins: [],
    clusters: [...cells.values()].map((g) => ({
      lat: g.lat / g.count,
      lng: g.lng / g.count,
      count: g.count,
      worstStatus: worstStatus(g.statuses),
    })),
  };
}

// ---------------- on-demand refresh (FR-ERP-003) ----------------

export async function refresh(user: AuthUser, id: string) {
  const c = await loadInScope(user, id);
  const now = ctx().clock.now();
  const last = c.fos?.lastRefreshAt as Date | null;
  if (last && now.getTime() - last.getTime() < 30_000)
    throw new AppError('RATE_LIMITED', {
      retryAfterSec: Math.ceil((30_000 - (now.getTime() - last.getTime())) / 1000),
    });
  await CustomerModel.updateOne({ _id: c._id }, { $set: { 'fos.lastRefreshAt': now } });
  try {
    const fresh = await erpRefresh(c.erpCustomerId);
    if (!fresh) throw notFound('customer');
  } catch (e) {
    if (e instanceof AppError) throw e;
    if (e instanceof ErpUnavailableError || e instanceof Error)
      throw new AppError('ERP_UNAVAILABLE', { reason: e.message.slice(0, 120) });
    throw e;
  }
  return detail(user, id);
}

// ---------------- pin corrections (FR-CUS-008) ----------------

export async function proposeLocation(
  user: AuthUser,
  customerId: string,
  input: {
    clientId: string;
    geo: { lat: number; lng: number; accuracyM: number; mock?: boolean };
    photoMediaId?: string | undefined;
    note?: string | undefined;
  },
  meta: RequestMeta,
) {
  const c = await loadInScope(user, customerId);
  const existing = await LocationProposalModel.findOne({ clientId: input.clientId }).lean();
  if (existing) return { id: existing._id.toHexString(), status: existing.status, replayed: true };
  if (input.geo.accuracyM > 30) throw businessRule('LOW_ACCURACY', { maxAccuracyM: 30 });
  if (input.geo.mock) throw businessRule('MOCK_LOCATION');
  if (classifyCoords(input.geo.lat, input.geo.lng) !== 'ok') throw businessRule('OUTSIDE_BANGLADESH');
  try {
    const p = await LocationProposalModel.create({
      clientId: input.clientId,
      customerId,
      branchId: c.branchId,
      proposedBy: user.id,
      point: { type: 'Point', coordinates: [input.geo.lng, input.geo.lat] },
      accuracyM: input.geo.accuracyM,
      photoMediaId: input.photoMediaId ?? null,
      note: input.note ?? null,
    });
    await audit.record({
      actor: user,
      action: 'customer.location.proposed',
      entity: 'customer',
      entityId: customerId,
      branchId: c.branchId,
      after: { lat: input.geo.lat, lng: input.geo.lng, accuracyM: input.geo.accuracyM },
      meta,
    });
    await ctx().bus.emit('customer.location.proposed', {
      proposalId: p._id.toHexString(),
      customerId,
      branchId: c.branchId,
    });
    return { id: p._id.toHexString(), status: 'pending', replayed: false };
  } catch (e) {
    if (isDuplicateKey(e)) return proposeLocation(user, customerId, input, meta);
    throw e;
  }
}

export async function listProposals(user: AuthUser, q: { branchId?: string; status?: string }) {
  const rows = await LocationProposalModel.find({ ...branchQuery(user, q.branchId), status: q.status ?? 'pending' })
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();
  const refs = await getCustomerRefs(rows.map((r) => r.customerId));
  const proposers = await getUsers(rows.map((r) => r.proposedBy ?? '').filter(Boolean));
  const nameOf = (id: string) => {
    const u = proposers.get(id);
    return u ? u.name.en || u.name.bn : '';
  };
  return rows.map((p) => ({
    id: p._id.toHexString(),
    customer: refs.get(p.customerId)
      ? {
          id: p.customerId,
          name: refs.get(p.customerId)!.name,
          code: refs.get(p.customerId)!.code,
          current: refs.get(p.customerId)!.location,
        }
      : { id: p.customerId },
    lat: p.point!.coordinates[1],
    lng: p.point!.coordinates[0],
    accuracyM: p.accuracyM,
    photoMediaId: p.photoMediaId,
    note: p.note,
    proposedBy: p.proposedBy,
    proposer: { id: p.proposedBy ?? '', name: nameOf(p.proposedBy ?? '') },
    status: p.status,
    createdAt: (p as unknown as { createdAt: Date }).createdAt.toISOString(),
  }));
}

export async function decideProposal(
  user: AuthUser,
  id: string,
  input: { decision: 'approve' | 'reject'; reason?: string | undefined },
  meta: RequestMeta,
) {
  if (!isOid(id)) throw notFound('location_proposal');
  const p = await LocationProposalModel.findOne({ _id: id, ...branchQuery(user, undefined) }).lean();
  if (!p) throw notFound('location_proposal');
  if (p.status !== 'pending') throw new AppError('INVALID_STATE', { reason: 'ALREADY_DECIDED' });
  if (input.decision === 'reject' && !input.reason) throw businessRule('REASON_REQUIRED');
  const now = ctx().clock.now();
  await LocationProposalModel.updateOne(
    { _id: id },
    {
      $set: {
        status: input.decision === 'approve' ? 'approved' : 'rejected',
        decidedBy: user.id,
        decidedAt: now,
        decisionReason: input.reason ?? null,
      },
    },
  );
  if (input.decision === 'approve') {
    const before = (await CustomerModel.findById(p.customerId).lean()) as Doc | null;
    const override = { point: p.point, approvedBy: user.id, approvedAt: now, proposalId: id };
    const c = (await CustomerModel.findByIdAndUpdate(
      p.customerId,
      {
        $set: {
          'fos.locationOverride': override,
          location: p.point,
          locationStatus: 'overridden',
          locationSource: 'overlay',
        },
        $inc: { version: 1 },
      },
      { new: true },
    ).lean()) as Doc;
    await audit.record({
      actor: user,
      action: 'customer.location.approved',
      entity: 'customer',
      entityId: p.customerId,
      branchId: p.branchId ?? null,
      before: { location: before?.location ?? null, status: before?.locationStatus },
      after: { location: p.point },
      reason: input.reason ?? null,
      meta,
    });
    await ctx().bus.emit('customer.location.approved', {
      customerId: p.customerId,
      branchId: p.branchId,
      proposalId: id,
    });
    if (c.fos?.assigneeId)
      await recordChange({
        entity: 'customer',
        entityId: p.customerId,
        userIds: [c.fos.assigneeId],
        branchId: c.branchId,
      });
  } else {
    await audit.record({
      actor: user,
      action: 'customer.location.rejected',
      entity: 'customer',
      entityId: p.customerId,
      branchId: p.branchId ?? null,
      reason: input.reason ?? null,
      meta,
    });
  }
  await ctx().bus.emit('customer.location.decided', {
    proposalId: id,
    proposedBy: p.proposedBy,
    decision: input.decision,
  });
  return { id, status: input.decision === 'approve' ? 'approved' : 'rejected' };
}

/** Counts for dashboards (FR-DSH-001) and overdue snapshots. */
export async function overdueSummary(filter: Record<string, unknown>) {
  const [r] = await CustomerModel.aggregate([
    { $match: filter },
    {
      $group: {
        _id: null,
        customers: { $sum: { $cond: ['$derived.overdue', 1, 0] } },
        amountPoisha: { $sum: { $cond: ['$derived.overdue', '$derived.overdueAmountPoisha', 0] } },
        badSuggested: { $sum: { $cond: ['$derived.badSuggested', 1, 0] } },
        tagged: { $sum: { $cond: [{ $eq: ['$fos.tag.state', 'tagged'] }, 1, 0] } },
        unassigned: { $sum: { $cond: [{ $eq: ['$fos.assigneeId', null] }, 1, 0] } },
      },
    },
  ]);
  return {
    customers: r?.customers ?? 0,
    amountPoisha: r?.amountPoisha ?? 0,
    badSuggested: r?.badSuggested ?? 0,
    tagged: r?.tagged ?? 0,
    unassigned: r?.unassigned ?? 0,
  };
}

/** Search helper (FR-SRCH-001). */
export async function searchCustomers(user: AuthUser, term: string, limit = 10) {
  const r = await list(user, { filter: [], q: term, radiusM: 0, limit, sort: 'name' });
  return r.items.map((c) => ({
    type: 'customer',
    id: c.id,
    title: c.name.bn || c.name.en,
    subtitle: `${c.code} · ${c.phone}`,
  }));
}

/** Closest customer pin to a point within `radiusM` in one branch (stop detection, FR-LOC-008). */
export async function nearestCustomer(branchId: string, at: LatLng, radiusM: number): Promise<{ id: string; name: { bn: string; en: string }; distanceM: number } | null> {
  const rows = (await CustomerModel.find({ branchId, location: { $geoWithin: { $centerSphere: [[at.lng, at.lat], radiusM / 6378100] } } })
    .select({ name: 1, location: 1 })
    .limit(50)
    .lean()) as Doc[];
  let best: { id: string; name: { bn: string; en: string }; distanceM: number } | null = null;
  for (const r of rows) {
    const d = Math.round(haversineM(at, { lat: r.location.coordinates[1], lng: r.location.coordinates[0] }));
    if (!best || d < best.distanceM) best = { id: r._id.toHexString(), name: r.name, distanceM: d };
  }
  return best;
}

/** FR-REP-002 aging of overdue customers from cached ERP values (never an official balance; see `erpFetchedAt`). */
export async function overdueAging(filter: Record<string, unknown>) {
  const rows = await CustomerModel.aggregate<{ _id: string; count: number; amountPoisha: number }>([
    { $match: { ...filter, 'derived.overdue': true } },
    { $group: { _id: { $switch: { branches: [{ case: { $lte: ['$derived.daysOverdue', 30] }, then: 'd1_30' }, { case: { $lte: ['$derived.daysOverdue', 60] }, then: 'd31_60' }, { case: { $lte: ['$derived.daysOverdue', 90] }, then: 'd61_90' }], default: 'd90p' } }, count: { $sum: 1 }, amountPoisha: { $sum: '$derived.overdueAmountPoisha' } } },
  ]);
  const buckets = { d1_30: { count: 0, amountPoisha: 0 }, d31_60: { count: 0, amountPoisha: 0 }, d61_90: { count: 0, amountPoisha: 0 }, d90p: { count: 0, amountPoisha: 0 } };
  for (const r of rows) buckets[r._id as keyof typeof buckets] = { count: r.count, amountPoisha: r.amountPoisha };
  return buckets;
}

export interface OverdueRow {
  id: string;
  code: string;
  name: { bn: string; en: string };
  branchId: string;
  assigneeId: string | null;
  daysOverdue: number;
  overdueAmountPoisha: number;
  nextDueDate: string | null;
  tag: string;
  erpFetchedAt: Date;
}

/** Overdue customers, most days overdue first (export). */
export async function overdueRows(filter: Record<string, unknown>, limit = 50_000): Promise<OverdueRow[]> {
  const rows = (await CustomerModel.find({ ...filter, 'derived.overdue': true }).sort({ 'derived.daysOverdue': -1 }).limit(limit).select({ code: 1, name: 1, branchId: 1, fos: 1, derived: 1, erpFetchedAt: 1 }).lean()) as Doc[];
  return rows.map((c) => ({
    id: c._id.toHexString(),
    code: c.code,
    name: c.name,
    branchId: c.branchId,
    assigneeId: c.fos?.assigneeId ?? null,
    daysOverdue: c.derived.daysOverdue,
    overdueAmountPoisha: c.derived.overdueAmountPoisha,
    nextDueDate: c.derived.nextDueDate ?? null,
    tag: c.fos?.tag?.state ?? 'none',
    erpFetchedAt: c.erpFetchedAt,
  }));
}

export interface ErpFieldPayment {
  customerId: string;
  code: string;
  erpPaymentId: string;
  idempotencyKey: string | null;
  receiptNo: string | null;
  amountPoisha: number;
  reversed: boolean;
  erpFetchedAt: Date;
}

/**
 * Field payments the ERP reported for one date, read from the cached recent payments (FR-COL-014).
 * Only as fresh as each customer's `erpFetchedAt`; the report shows that age next to the figures.
 */
export async function erpFieldPayments(filter: Record<string, unknown>, date: string): Promise<ErpFieldPayment[]> {
  const rows = (await CustomerModel.find({ ...filter, recentPayments: { $elemMatch: { source: 'field', date } } }).select({ code: 1, recentPayments: 1, erpFetchedAt: 1 }).lean()) as Doc[];
  const out: ErpFieldPayment[] = [];
  for (const c of rows)
    for (const p of (c.recentPayments ?? []) as LooseObject[])
      if (p.source === 'field' && p.date === date) out.push({ customerId: c._id.toHexString(), code: c.code, erpPaymentId: p.erpPaymentId, idempotencyKey: p.idempotencyKey ?? null, receiptNo: p.receiptNo ?? null, amountPoisha: p.amountPoisha, reversed: !!p.reversed, erpFetchedAt: c.erpFetchedAt });
  return out;
}
