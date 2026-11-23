import { Types } from 'mongoose';
import { ctx } from '../../core/context/index.js';
import { AppError, businessRule, notFound } from '../../core/errors/index.js';
import { isDuplicateKey, isOid, type LeanDoc, type LooseObject } from '../../core/db/index.js';
import { recordChange, recordChanges, type ChangeInput } from '../../core/changefeed/index.js';
import { classifyCoords, haversineM, parseBbox, type LatLng } from '../../core/geo/index.js';
import { decodeCursor, encodeCursor } from '../../core/http/index.js';
import { formatBdt } from '../../core/money/index.js';
import { businessDate, diffDays } from '../../core/time/index.js';
import { branchQuery, isSuperAdmin, type AuthUser } from '../../core/security/types.js';
import type { RequestMeta } from '../../core/http/router.js';
import * as audit from '../audit/index.js';
import { getBranches, getByErpBranchId } from '../branches/index.js';
import { getUsers } from '../users/index.js';
import { getSetting } from '../settings/index.js';
import { refreshCustomer as erpRefresh, ErpUnavailableError, type ErpCustomer } from '../erp-gateway/index.js';
import { badges, deriveCustomer, isBadTag, payState, worstPayState, worstStatus, type CustomerStatus, type PayState } from './domain/status.js';
import { MAX_EXTRA_PHONES, mergePhones, normalizeMobile, planAdd, type ExtraPhone, type PhoneInput } from './domain/phones.js';
import { paidThisMonthFilter, type PaidThisMonth } from './domain/paid-month.js';
import { paidByOfMonth, type ActivityPerson, type MonthCollectionRef, type MonthPaymentRef } from './domain/activity-by.js';
import { QUALITY_ISSUES, findIssues, sharedPhones, type Finding, type QualityInput } from './domain/quality.js';
import { CustomerModel, LocationProposalModel } from './models/customer.model.js';

type Doc = LeanDoc;
const today = () => businessDate(ctx().clock.now());

// ---------------- extension points (inversion of control, no import cycles) ----------------

export interface ListExtras {
  openPromise?: Record<string, unknown> | null;
  lastVisitAt?: string | null;
  /** 1.44.0: who made the last visit (any month). */
  lastVisitByName?: string | null;
  pendingFieldPoisha?: number;
  areaName?: { bn: string; en: string } | null;
  /** 1.24.0 (FR-CUS-017): this Dhaka month's work on the customer, each part supplied by its own module. */
  /** `by` (1.44.0, FR-CUS-021): who made this month's visits. */
  monthVisits?: { count: number; lastAt: string | null; today: boolean; by?: ActivityPerson[] };
  /** Field collections recorded this month that are not in the ERP yet (never added to ERP money). */
  monthPendingPoisha?: number;
  /** `by` (1.44.0, FR-CUS-021): who made this month's promises (cancelled ones left out). */
  monthPromises?: { made: number; kept: number; broken: number; by?: ActivityPerson[] };
  /** 1.44.0 (FR-CUS-021): field collections of this month with their collector, to name who took the money. */
  monthCollections?: MonthCollectionRef[];
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
/**
 * 1.29.0 (FR-CUS-019): who has a field collection of the given Dhaka month still waiting for the ERP. Supplied by
 * the collections module so the "paid this month" filter counts pending field money like the row's `activity` does.
 */
export type MonthPendingSource = (month: string) => Promise<string[]>;
const monthPendingSources: MonthPendingSource[] = [];
export const registerMonthPendingSource = (s: MonthPendingSource) => void monthPendingSources.push(s);
async function monthPendingIds(month: string): Promise<Types.ObjectId[]> {
  const ids = new Set<string>();
  for (const src of monthPendingSources) for (const id of await src(month)) ids.add(id);
  return [...ids].filter(isOid).map((id) => new Types.ObjectId(id));
}

// ---------------- scope (CLAUDE.md §2.7, 04-architecture §6.2) ----------------

export type StaffVisibility = 'branch' | 'assigned';

/**
 * Of these branches, the ones where field staff see every customer of the branch (setting
 * `customers.staffVisibility` = `branch`, the default since 1.19.0, ADR-038) rather than only their own.
 */
export async function wholeBranchIds(branchIds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const b of branchIds) if ((await getSetting<StaffVisibility>('customers.staffVisibility', b)) !== 'assigned') out.push(b);
  return out;
}

/**
 * SA → all; BM/viewer → their branches; field staff → every customer of their branches (one or more), or only
 * the ones assigned to them in a branch set to `assigned` (the rule before 1.19.0). Assignment still decides whose
 * work a customer is (Today, targets, handovers); it no longer hides the rest of the branch.
 */
export async function scopeFilter(user: AuthUser): Promise<Record<string, unknown>> {
  if (isSuperAdmin(user)) return {};
  const inBranches = { branchId: { $in: user.branchIds } };
  if (user.role !== 'field_staff') return inBranches;
  const whole = await wholeBranchIds(user.branchIds);
  if (whole.length === user.branchIds.length) return inBranches;
  if (!whole.length) return { 'fos.assigneeId': user.id, ...inBranches };
  return { ...inBranches, $or: [{ branchId: { $in: whole } }, { 'fos.assigneeId': user.id }] };
}

/** Change-feed entry for a customer: the given users, plus every device of the branch where staff see it whole. */
async function customerFeed(
  id: string,
  branchId: string | null | undefined,
  userIds: (string | null | undefined)[],
  extra: Partial<ChangeInput> = {},
): Promise<ChangeInput> {
  const fanout = branchId && (await wholeBranchIds([branchId])).length ? branchId : null;
  return { entity: 'customer', entityId: id, userIds: userIds.filter((u): u is string => !!u), branchId: branchId ?? null, fanoutBranchId: fanout, ...extra };
}

/**
 * Re-send every customer of these branches through the change feed so devices converge: each device loads the
 * ones now in its scope and drops the rest. `userId` = one user (their branches changed), else every device of
 * each branch (the visibility setting changed).
 */
export async function refeedBranches(branchIds: string[], userId?: string): Promise<number> {
  let n = 0;
  for (const branchId of [...new Set(branchIds)]) {
    const rows = (await CustomerModel.find({ branchId }).select({ _id: 1 }).lean()) as Doc[];
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000);
      await recordChanges(
        chunk.map((r) => ({
          entity: 'customer',
          entityId: r._id.toHexString(),
          userIds: userId ? [userId] : [],
          branchId,
          fanoutBranchId: userId ? null : branchId,
          reason: 'out_of_scope',
        })),
      );
      n += chunk.length;
    }
  }
  return n;
}

async function loadInScope(user: AuthUser, id: string): Promise<Doc> {
  if (!isOid(id)) throw notFound('customer');
  const c = (await CustomerModel.findOne({ _id: id, ...(await scopeFilter(user)) }).lean()) as Doc | null;
  if (!c) throw notFound('customer'); // out of scope → 404 (ADR-022)
  return c;
}

export async function inScope(user: AuthUser, id: string): Promise<boolean> {
  if (!isOid(id)) return false;
  return !!(await CustomerModel.exists({ _id: id, ...(await scopeFilter(user)) }));
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
  const c = (await CustomerModel.findOne({ _id: id, ...(user ? await scopeFilter(user) : {}) }).lean()) as Doc | null;
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
  // 1.17.0: a manager deleted the pin. The ERP coordinates stay in `erpLocation`, but they are not shown again
  // until someone sets a new pin (which replaces this override).
  if (override?.cleared) return { location: undefined, locationStatus: 'missing', locationSource: 'overlay' };
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
    detailedAddress: c.detailedAddress ?? null,
    directions: c.directions ?? null,
    erpRisk: c.risk ?? null,
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
  const feed = [await customerFeed(id, branch.id, [doc.fos?.assigneeId])];
  // Moved to another branch: the old branch's devices drop it (their loader finds it out of scope).
  if (prev?.branchId && prev.branchId !== branch.id) feed.push(await customerFeed(id, prev.branchId, [], { reason: 'out_of_scope' }));
  await recordChanges(feed);
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
  // Also documents derived before 1.14.0, which have no missedCount yet (ADR-035).
  const cursor = CustomerModel.find({ $or: [{ 'derived.computedFor': { $ne: date } }, { 'derived.missedCount': null }] })
    .lean()
    .cursor();
  for await (const c of cursor as AsyncIterable<Doc>) {
    const prevBad = !!c.derived?.badSuggested;
    const derived = derivedFor(c.plans ?? [], date);
    await CustomerModel.updateOne({ _id: c._id }, { $set: { derived }, $inc: { version: 1 } });
    if (prevBad !== derived.badSuggested || c.derived?.overdue !== derived.overdue || c.derived?.dueToday !== derived.dueToday)
      await recordChange(await customerFeed(c._id.toHexString(), c.branchId, [c.fos?.assigneeId]));
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

/**
 * assignment.changed → denormalize primary assignee. The old and new assignee (and, where staff see the whole
 * branch, every device of it) reload the customer; a device it left the scope of gets a tombstone from the loader.
 */
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
    const moved = !!before && before !== ch.assigneeId;
    if (moved || ch.assigneeId) feed.push(await customerFeed(ch.customerId, prev.branchId, [before, ch.assigneeId], moved ? { reason: 'unassigned' } : {}));
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
  if (c) await recordChange(await customerFeed(customerId, c.branchId, [c.fos?.assigneeId]));
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

/** Missed installments; documents cached before 1.14.0 count their overdue lines until the recompute job runs. */
function missedOf(c: Doc): number {
  const m = c.derived?.missedCount;
  if (typeof m === 'number') return m;
  return (c.derived?.plans ?? []).reduce(
    (n: number, p: LooseObject) => n + ((p.lines ?? []) as LooseObject[]).filter((l) => l.status === 'overdue').length,
    0,
  );
}

/** FR-CUS-012 / ADR-035: the colour of the customer's map pin. */
function payStateOf(c: Doc): PayState {
  return payState(
    {
      badSuggested: !!c.derived?.badSuggested,
      missedCount: missedOf(c),
      dueToday: !!c.derived?.dueToday,
      totalOutstandingPoisha: c.derived?.totalOutstandingPoisha ?? 0,
    },
    { badTag: isBadTag(c.fos?.tag) },
  );
}

const isOpenPlan = (p: LooseObject) => p.status !== 'closed' && p.status !== 'cancelled' && (p.outstandingPoisha ?? 0) > 0;

/** Open (balance due) installment and credit invoices, for list badges and the invoice filters (1.14.0). */
function openInvoices(c: Doc): { installment: number; credit: number } {
  const out = { installment: 0, credit: 0 };
  for (const p of (c.plans ?? []) as LooseObject[]) if (isOpenPlan(p)) out[p.kind === 'credit' ? 'credit' : 'installment']++;
  return out;
}

/** Every invoice of the customer and how many are still open (1.24.0); cancelled ones are not counted. */
function invoiceCount(c: Doc): { total: number; open: number } {
  const plans = ((c.plans ?? []) as LooseObject[]).filter((p) => p.status !== 'cancelled');
  return { total: plans.length, open: plans.filter(isOpenPlan).length };
}

/**
 * 1.24.0 (FR-CUS-017): what happened with the customer in the current Dhaka month. `paidPoisha` is ERP money
 * (payments dated this month among the recent ERP payments, removed ones left out); `pendingPoisha` is field
 * money not in the ERP yet. The two are separate numbers and are never added together (CLAUDE.md §2.1).
 */
function monthActivity(c: Doc, x: ListExtras, date: string) {
  const month = date.slice(0, 7);
  let paid = 0;
  let lastPaidDate: string | null = null;
  for (const p of (c.recentPayments ?? []) as LooseObject[]) {
    if (p.reversed || typeof p.date !== 'string' || !p.date.startsWith(month)) continue;
    paid += p.amountPoisha ?? 0;
    if (!lastPaidDate || p.date > lastPaidDate) lastPaidDate = p.date;
  }
  // 1.44.0 (FR-CUS-021): the names behind the numbers below.
  const visitedBy = x.monthVisits?.by ?? [];
  const paidBy = paidByOfMonth(month, (c.recentPayments ?? []) as MonthPaymentRef[], x.monthCollections ?? []);
  return {
    month,
    visitCount: x.monthVisits?.count ?? 0,
    visitedToday: x.monthVisits?.today ?? false,
    lastVisitAt: x.monthVisits?.lastAt ?? null,
    paidPoisha: paid,
    lastPaidDate,
    pendingPoisha: x.monthPendingPoisha ?? 0,
    promisesMade: x.monthPromises?.made ?? 0,
    promisesKept: x.monthPromises?.kept ?? 0,
    promisesBroken: x.monthPromises?.broken ?? 0,
    visitedBy,
    paidBy,
    promisedBy: x.monthPromises?.by ?? [],
    lastVisitByName: visitedBy[0]?.name || null,
    lastPaidByName: paidBy[0]?.name || null,
  };
}

/** ERP numbers first, then the ones added in FOS (FR-CUS-016). */
const phoneList = (c: Doc) => mergePhones(c.phones as string[] | undefined, c.fos?.extraPhones as ExtraPhone[] | undefined);

/** The two phone fields of a customer detail: plain numbers (as before 1.23.0) and where each came from. */
function phonesView(c: Doc) {
  const list = phoneList(c);
  return { phones: list.map((p) => p.number), phoneDetails: list };
}

async function listItems(rows: Doc[], user: AuthUser, near: LatLng | null) {
  const ids = rows.map((r) => r._id.toHexString());
  const date = today();
  const assignees = await getUsers(rows.map((r) => r.fos?.assigneeId).filter(Boolean));
  const branches = await getBranches([...new Set(rows.map((r) => r.branchId).filter(Boolean) as string[])]);
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
    const b = c.branchId ? branches.get(c.branchId) : undefined;
    return {
      id,
      erpCustomerId: c.erpCustomerId,
      code: c.code ?? '',
      name: { bn: c.name?.bn ?? '', en: c.name?.en ?? '' },
      phone: phoneList(c)[0]?.number ?? '',
      address: c.address ?? '',
      location: loc,
      distanceM: near && loc.lat !== null ? Math.round(haversineM(near, { lat: loc.lat, lng: loc.lng })) : null,
      totalOutstandingPoisha: c.derived?.totalOutstandingPoisha ?? 0,
      nextDueDate: c.derived?.nextDueDate ?? null,
      daysOverdue: c.derived?.daysOverdue ?? 0,
      badges: statusBadges(c, date),
      payState: payStateOf(c),
      missedCount: missedOf(c),
      openInvoices: openInvoices(c),
      invoiceCount: invoiceCount(c),
      activity: monthActivity(c, x, date),
      tag: tagView(c),
      openPromise: x.openPromise ?? null,
      lastVisitAt: x.lastVisitAt ?? null,
      lastVisitByName: x.lastVisitByName ?? null,
      pendingFieldPoisha: x.pendingFieldPoisha ?? 0,
      installmentPoisha: c.derived?.nextInstallmentPoisha ?? null,
      overduePoisha: c.derived?.overdueAmountPoisha ?? 0,
      areaName: x.areaName ?? null,
      branchId: c.branchId ?? null,
      // 1.19.0: staff may work in several branches, so every row says which one it belongs to.
      ...(b ? { branch: { id: b.id, code: b.code, name: { bn: b.name.bn || b.name.en, en: b.name.en || b.name.bn } } } : {}),
      ...(a ? { assignee: { id: a.id, name: a.name.en || a.name.bn } } : {}),
      erpFetchedAt: (c.erpFetchedAt as Date).toISOString(),
    };
  });
}

export interface ListQuery {
  filter: string[];
  /** 1.14.0: pin colours (OR), see payState(). */
  payState?: PayState[];
  /** 1.14.0: has an open invoice of this kind. */
  invoiceKind?: 'installment' | 'credit';
  /** 1.29.0 (FR-CUS-019): paid something this Dhaka month (ERP payment or pending field collection), or not. */
  paidThisMonth?: PaidThisMonth;
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

/** FOS tag that makes a customer red (isBadTag): tagged, severity anything but watch. */
const BAD_TAG = { 'fos.tag.state': 'tagged', 'fos.tag.severity': { $ne: 'watch' } };
const NOT_BAD = { 'derived.badSuggested': { $ne: true }, $nor: [BAD_TAG] };

/** Mongo form of payState() (same order of rules). Needs derived.missedCount (recompute job, 1.14.0). */
const PAY_FILTERS: Record<PayState, Record<string, unknown>> = {
  bad: { $or: [BAD_TAG, { 'derived.badSuggested': true }] },
  missed_many: { ...NOT_BAD, 'derived.missedCount': { $gte: 2 } },
  missed_one: { ...NOT_BAD, 'derived.missedCount': 1 },
  due_today: { ...NOT_BAD, 'derived.missedCount': 0, 'derived.totalOutstandingPoisha': { $gt: 0 }, 'derived.dueToday': true },
  on_track: { ...NOT_BAD, 'derived.missedCount': 0, 'derived.totalOutstandingPoisha': { $gt: 0 }, 'derived.dueToday': { $ne: true } },
  paid_off: { ...NOT_BAD, 'derived.totalOutstandingPoisha': 0 },
};

/** Has an open invoice of this kind; plans cached before 1.13.0 have no kind and are installment plans. */
function invoiceKindFilter(kind: 'installment' | 'credit'): Record<string, unknown> {
  return {
    plans: {
      $elemMatch: {
        kind: kind === 'credit' ? 'credit' : { $ne: 'credit' },
        status: { $nin: ['closed', 'cancelled'] },
        outstandingPoisha: { $gt: 0 },
      },
    },
  };
}

async function buildFilter(user: AuthUser, q: ListQuery): Promise<Record<string, unknown>> {
  const and: Record<string, unknown>[] = [await scopeFilter(user)];
  if (q.branchId) and.push(branchQuery(user, q.branchId));
  // Status filters combine with OR ("due today or overdue"); other params narrow with AND.
  const ors = q.filter.filter((f) => STATUS_FILTERS[f]).map((f) => STATUS_FILTERS[f]!(today()));
  if (ors.length) and.push({ $or: ors });
  if (q.payState?.length) and.push({ $or: q.payState.map((p) => PAY_FILTERS[p]) });
  if (q.invoiceKind) and.push(invoiceKindFilter(q.invoiceKind));
  if (q.paidThisMonth) {
    const month = today().slice(0, 7);
    and.push(paidThisMonthFilter(q.paidThisMonth, month, await monthPendingIds(month)));
  }
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
        ...(digits.length >= 4 ? [{ phones: { $regex: digits.slice(-10) } }, { 'fos.extraPhones.number': { $regex: digits.slice(-10) } }] : []),
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
  const filter = await buildFilter(user, q);
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
    ...(q.includeTotal ? { total: await CustomerModel.countDocuments(filter).limit(10_000), invoiceTotals: await invoiceTotals(filter) } : {}),
  };
}

/**
 * 1.24.0 (FR-CUS-018): invoices of the customers a list query matches (the whole result, not one page), so the
 * admin panel and the app can say "N customers, M invoices". Same rules as a row's `invoiceCount` / `openInvoices`.
 */
async function invoiceTotals(filter: Record<string, unknown>) {
  const open = { $and: [{ $not: [{ $in: ['$plans.status', ['closed', 'cancelled']] }] }, { $gt: [{ $ifNull: ['$plans.outstandingPoisha', 0] }, 0] }] };
  const credit = { $eq: ['$plans.kind', 'credit'] };
  const [row] = (await CustomerModel.aggregate([
    { $match: filter },
    { $project: { plans: 1 } },
    { $unwind: '$plans' },
    { $match: { 'plans.status': { $ne: 'cancelled' } } },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        open: { $sum: { $cond: [open, 1, 0] } },
        installmentOpen: { $sum: { $cond: [{ $and: [open, { $not: [credit] }] }, 1, 0] } },
        creditOpen: { $sum: { $cond: [{ $and: [open, credit] }, 1, 0] } },
      },
    },
  ])) as { total: number; open: number; installmentOpen: number; creditOpen: number }[];
  return { total: row?.total ?? 0, open: row?.open ?? 0, installmentOpen: row?.installmentOpen ?? 0, creditOpen: row?.creditOpen ?? 0 };
}

/** Plan-level payment state for the invoice list (same rules as the customer, without FOS tags). */
function planPayState(p: LooseObject, d: LooseObject | undefined, date: string): PayState | null {
  if (p.status === 'closed' || p.status === 'cancelled') return null;
  const lines = (d?.lines ?? []) as LooseObject[];
  return payState(
    {
      badSuggested: !!d?.badSuggested,
      missedCount: typeof d?.missedCount === 'number' ? d.missedCount : lines.filter((l) => l.status === 'overdue').length,
      dueToday: lines.some((l) => l.dueDate === date && (l.outstandingPoisha ?? 0) > 0),
      totalOutstandingPoisha: p.outstandingPoisha ?? 0,
    },
    { badTag: false },
  );
}

function planView(p: LooseObject, d: LooseObject | undefined, branchIdOf: Map<string, string> = new Map()) {
  const date = today();
  const raw = new Map<number, LooseObject>(((p.schedule ?? []) as LooseObject[]).map((l) => [l.seq as number, l]));
  const lines = (d?.lines ?? []) as LooseObject[];
  const open = lines.filter((l) => (l.outstandingPoisha ?? 0) > 0);
  const next = open.filter((l) => l.dueDate >= date).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
  const oldestMissed = lines.filter((l) => l.missed || (l.status === 'overdue' && l.missed === undefined))[0];
  const ps = planPayState(p, d, date);
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
    schedule: lines.map((l: LooseObject) => {
      const r = raw.get(l.seq as number);
      return {
        seq: l.seq,
        dueDate: l.dueDate,
        amountPoisha: l.amountPoisha,
        paidPoisha: l.paidPoisha,
        status: l.status,
        estimated: l.estimated,
        lateFeePoisha: l.lateFeePoisha ?? 0,
        rolled: !!l.rolled,
        // 1.14.0: invoice viewer (FR-CUS-013). payments come from the ERP allocations; absent on older ERP versions.
        outstandingPoisha: l.outstandingPoisha ?? Math.max(0, (l.amountPoisha ?? 0) - (l.paidPoisha ?? 0)),
        ...(l.paidOn ? { paidOn: l.paidOn } : {}),
        daysLate: l.daysLate ?? 0,
        missed: !!l.missed,
        ...(r?.writtenOffPoisha ? { writtenOffPoisha: r.writtenOffPoisha } : {}),
        ...(Array.isArray(r?.payments)
          ? {
              payments: (r.payments as LooseObject[]).map((x) => ({
                erpPaymentId: x.erpPaymentId,
                date: x.date,
                amountPoisha: x.amountPoisha,
                ...(x.receiptNo ? { receiptNo: x.receiptNo } : {}),
              })),
            }
          : {}),
      };
    }),
    // 1.13.0: what the plan is in the ERP (ADR-033). Absent on data synced before 1.13.0.
    ...(p.kind ? { kind: p.kind } : {}),
    ...(p.invoiceNo ? { invoiceNo: p.invoiceNo } : {}),
    ...(p.saleDate ? { saleDate: p.saleDate } : {}),
    ...(p.frequency ? { frequency: p.frequency } : {}),
    ...(p.customDays != null ? { customDays: p.customDays } : {}),
    ...(Array.isArray(p.items) ? { items: p.items } : {}),
    ...(p.guarantor ? { guarantor: { name: p.guarantor.name, phone: p.guarantor.phone ?? '', phones: p.guarantor.phones ?? [], ...(p.guarantor.address ? { address: p.guarantor.address } : {}) } } : {}),
    ...(p.writtenOffPoisha ? { writtenOffPoisha: p.writtenOffPoisha } : {}),
    // ---- 1.14.0: invoice viewer (FR-CUS-013) ----
    ...(ps ? { payState: ps } : {}),
    missedCount: typeof d?.missedCount === 'number' ? d.missedCount : lines.filter((l) => l.status === 'overdue').length,
    daysOverdue: oldestMissed && oldestMissed.dueDate < date ? diffDays(oldestMissed.dueDate, date) : 0,
    ...(next ? { nextDueDate: next.dueDate, nextDuePoisha: next.outstandingPoisha } : {}),
    ...(p.erpBranchId && branchIdOf.get(p.erpBranchId) ? { branchId: branchIdOf.get(p.erpBranchId) } : {}),
    ...optionalMoney(p, ['financedPoisha', 'subtotalPoisha', 'discountPoisha', 'taxPoisha', 'settlementDiscountPoisha', 'refundedPoisha']),
    ...(p.invoiceStatus ? { invoiceStatus: p.invoiceStatus } : {}),
    ...(p.paymentStatus ? { paymentStatus: p.paymentStatus } : {}),
    ...(p.creditDueDate ? { creditDueDate: p.creditDueDate } : {}),
    ...(p.penaltyEnabled !== undefined ? { penalty: { enabled: !!p.penaltyEnabled, ...(p.penaltyRate ? { rate: p.penaltyRate } : {}) } } : {}),
  };
}

function optionalMoney(p: LooseObject, keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) if (typeof p[k] === 'number') out[k] = p[k] as number;
  return out;
}

/** ERP branch id → FOS branch id for the branches the customer's invoices were sold at (usually one). */
type ErpBranchLookup = (erpBranchId: string) => Promise<{ id: string } | null>;

async function invoiceBranchIds(c: Doc, lookup: ErpBranchLookup = getByErpBranchId): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const erpIds = [...new Set(((c.plans ?? []) as LooseObject[]).map((p) => p.erpBranchId as string).filter(Boolean))];
  for (const e of erpIds) {
    if (e === c.erpBranchId && c.branchId) out.set(e, c.branchId as string);
    else {
      const b = await lookup(e);
      if (b) out.set(e, b.id);
    }
  }
  return out;
}

/** One branch lookup per ERP branch for a whole page, not one per customer. */
function cachedErpBranchLookup(): ErpBranchLookup {
  const cache = new Map<string, Promise<{ id: string } | null>>();
  return (e) => {
    if (!cache.has(e)) cache.set(e, getByErpBranchId(e));
    return cache.get(e)!;
  };
}

/** Runs `fn` over `items` with at most `limit` in flight; keeps the order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!, i);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
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
  return detailFrom(c, item!, user);
}

/**
 * Sync payload for a page of customers (bootstrap, pull). The list part is built once for the page and the rest
 * runs a few customers at a time: a whole branch is hundreds of customers, and one-by-one queries made the
 * snapshot outlast a 60 s serverless call, so the phone never finished its first load (2026-11-19).
 * One customer whose extra data fails still goes to the phone with its list data, instead of failing the page.
 */
async function detailsOf(rows: Doc[], user: AuthUser): Promise<Record<string, unknown>[]> {
  const items = await listItems(rows, user, null);
  const lookup = cachedErpBranchLookup();
  return mapLimit(rows, 8, async (c, i) => {
    try {
      return await detailFrom(c, items[i]!, user, lookup);
    } catch (err) {
      ctx().logger.warn({ err, customerId: c._id.toHexString() }, 'customer detail for sync failed; sending list data only');
      return { ...items[i]!, ...phonesView(c), plans: [], payments: [], pendingCollections: [], recentNotes: [], lastVisit: null, badSuggestion: null, version: c.version ?? 1 };
    }
  });
}

async function detailFrom(c: Doc, item: Awaited<ReturnType<typeof listItems>>[number], user: AuthUser, lookup?: ErpBranchLookup) {
  const branchIdOf = await invoiceBranchIds(c, lookup);
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
    ...item,
    ...phonesView(c),
    ...(c.guarantor ? { guarantor: c.guarantor } : {}),
    plans: (c.plans ?? []).map((p: LooseObject) => planView(p, dPlans.get(p.erpPlanId), branchIdOf)),
    payments: (c.recentPayments ?? []).map((p: LooseObject) => ({
      erpPaymentId: p.erpPaymentId,
      date: p.date,
      amountPoisha: p.amountPoisha,
      method: p.method,
      source: p.source,
      receiptNo: p.receiptNo ?? '',
      reversed: !!p.reversed,
      ...(p.erpPlanId ? { erpPlanId: p.erpPlanId } : {}),
      ...(p.methodLabel ? { methodLabel: p.methodLabel } : {}),
      ...(p.collectorName ? { collectorName: p.collectorName } : {}),
      // 1.44.0: the ERP referrer employee's name (null when the payment has no employee, ADR-049)
      referrerName: p.collectorEmployeeId ? (p.referrerName ?? p.collectorName ?? null) : null,
      ...(p.advance ? { advance: true } : {}),
      ...(p.discountPoisha ? { discountPoisha: p.discountPoisha } : {}),
    })),
    ...(c.detailedAddress ? { detailedAddress: c.detailedAddress } : {}),
    ...(c.directions ? { directions: c.directions } : {}),
    ...(c.erpRisk ? { erpRisk: c.erpRisk } : {}),
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
  const rows = (await CustomerModel.find({ _id: { $in: ids.filter(isOid) }, ...(await scopeFilter(user)) }).lean()) as Doc[];
  const details = await detailsOf(rows, user);
  return new Map(rows.map((r, i) => [r._id.toHexString(), details[i]!]));
}

export async function syncSnapshot(user: AuthUser, cursor: string | null, limit: number) {
  const c = decodeCursor<{ id: string }>(cursor ?? undefined);
  const rows = (await CustomerModel.find({ ...(await scopeFilter(user)), ...(c ? { _id: { $gt: c.id } } : {}) })
    .sort({ _id: 1 })
    .limit(limit + 1)
    .lean()) as Doc[];
  const page = rows.slice(0, limit);
  const items = await detailsOf(page, user);
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
  const pinPeople = await getUsers(proposals.map((p) => (p.direct ? p.decidedBy : p.proposedBy) ?? '').filter(Boolean));
  for (const p of proposals) {
    const who = (p.direct ? p.decidedBy : p.proposedBy) ?? '';
    const u = pinPeople.get(who);
    items.push({
      kind: 'location_correction',
      at: p.decidedAt!.toISOString(),
      ...(u ? { actor: { id: u.id, name: u.name.en || u.name.bn } } : {}),
      summary: p.direct
        ? { en: 'Map pin set by a manager', bn: 'ম্যানেজার ম্যাপ পিন বসিয়েছেন' }
        : p.autoApplied
          ? { en: 'Map pin added from the field', bn: 'মাঠ থেকে ম্যাপ পিন যোগ হয়েছে' }
          : { en: 'Map pin corrected', bn: 'ম্যাপ পিন সংশোধন' },
      refId: p._id.toHexString(),
      data: { method: p.method ?? 'gps', direct: !!p.direct, autoApplied: !!p.autoApplied },
    });
  }
  for (const src of timelineSources) items.push(...(await src(id, user, beforeDate, limit)));
  items.sort((a, b) => b.at.localeCompare(a.at));
  const page = items.slice(0, limit);
  return { items: page, nextCursor: items.length > limit ? encodeCursor({ before: page[page.length - 1]!.at }) : null };
}

export async function map(
  user: AuthUser,
  q: { bbox: string; zoom?: number; filter: string[]; branchId?: string; payState?: PayState[]; invoiceKind?: 'installment' | 'credit'; paidThisMonth?: PaidThisMonth },
) {
  const box = parseBbox(q.bbox);
  if (!box)
    throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'bbox', message: 'minLng,minLat,maxLng,maxLat' }] });
  const filter = await buildFilter(user, {
    filter: q.filter,
    radiusM: 0,
    limit: 0,
    ...(q.branchId ? { branchId: q.branchId } : {}),
    ...(q.payState?.length ? { payState: q.payState } : {}),
    ...(q.invoiceKind ? { invoiceKind: q.invoiceKind } : {}),
    ...(q.paidThisMonth ? { paidThisMonth: q.paidThisMonth } : {}),
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
    payState: payStateOf(c),
    missedCount: missedOf(c),
  }));
  if ((q.zoom ?? 15) >= 13 && pins.length <= 2000) return { pins, clusters: [] };
  // Grid clustering: cell ≈ 1/8 of a tile at this zoom.
  const cell = 360 / 2 ** (q.zoom ?? 10) / 8;
  const cells = new Map<string, { lat: number; lng: number; count: number; statuses: CustomerStatus[]; pay: Partial<Record<PayState, number>> }>();
  for (const p of pins) {
    const k = `${Math.floor(p.lat / cell)}:${Math.floor(p.lng / cell)}`;
    const g = cells.get(k) ?? { lat: 0, lng: 0, count: 0, statuses: [], pay: {} };
    g.lat += p.lat;
    g.lng += p.lng;
    g.count++;
    g.statuses.push(p.status);
    g.pay[p.payState] = (g.pay[p.payState] ?? 0) + 1;
    cells.set(k, g);
  }
  return {
    pins: [],
    clusters: [...cells.values()].map((g) => ({
      lat: g.lat / g.count,
      lng: g.lng / g.count,
      count: g.count,
      worstStatus: worstStatus(g.statuses),
      worstPayState: worstPayState(Object.keys(g.pay) as PayState[]),
      payStates: g.pay,
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

// ---------------- pin corrections (FR-CUS-008) and map pins (FR-CUS-011) ----------------

const hasUsablePin = (c: Doc) => c.locationStatus === 'ok' || c.locationStatus === 'overridden';

/**
 * Make `point` the customer's official FOS pin (overlay over the ERP coordinates, ADR-025) and tell
 * everyone who depends on it: the assignee's phone (change feed) and the assignments module, because a
 * new pin can move the customer into or out of a polygon area (`customer.placed`).
 */
async function applyPin(customerId: string, point: { type: 'Point'; coordinates: number[] }, override: Record<string, unknown>) {
  const before = (await CustomerModel.findById(customerId).lean()) as Doc | null;
  const c = (await CustomerModel.findByIdAndUpdate(
    customerId,
    {
      $set: {
        'fos.locationOverride': { point, ...override },
        location: point,
        locationStatus: 'overridden',
        locationSource: 'overlay',
      },
      $inc: { version: 1 },
    },
    { new: true },
  ).lean()) as Doc;
  await recordChange(await customerFeed(customerId, c.branchId, [c.fos?.assigneeId]));
  // Before 1.11.0 an approved pin did not recompute polygon areas until the next area edit.
  if (c.branchId)
    await ctx().bus.emit('customer.placed', { customerId, branchId: c.branchId, areaCode: c.areaCode ?? null, isNew: false });
  return { before, after: c };
}

type GeoInput = { lat: number; lng: number; accuracyM: number; mock?: boolean | undefined };

export async function proposeLocation(
  user: AuthUser,
  customerId: string,
  input: {
    clientId: string;
    geo: GeoInput;
    method?: 'gps' | 'map' | undefined;
    deviceGeo?: GeoInput | null | undefined;
    photoMediaId?: string | undefined;
    note?: string | undefined;
  },
  meta: RequestMeta,
) {
  const c = await loadInScope(user, customerId);
  const existing = await LocationProposalModel.findOne({ clientId: input.clientId }).lean();
  if (existing) return { id: existing._id.toHexString(), status: existing.status, replayed: true, direct: !!existing.direct };
  const method = input.method ?? 'gps';
  // A GPS pin is only as good as the fix; a map pin is chosen by eye, so these checks apply to the phone fix only.
  if (method === 'gps') {
    if (input.geo.accuracyM > 30) throw businessRule('LOW_ACCURACY', { maxAccuracyM: 30 });
    if (input.geo.mock) throw businessRule('MOCK_LOCATION');
  }
  if (classifyCoords(input.geo.lat, input.geo.lng) !== 'ok') throw businessRule('OUTSIDE_BANGLADESH');
  const device = method === 'map' ? (input.deviceGeo ?? null) : null;
  const deviceMock = !!device?.mock;
  // Owner decision 2026-11-17 (ADR-031): a staff pin for a customer without a usable pin is applied at once,
  // unless the branch asks for approval of every pin. Moving an existing pin always waits for a manager.
  // 1.39.0 (owner request 2026-11-22, ADR-052): someone who may approve pins in the customer's branch does not wait
  // for themselves; their pin from the app applies at once like a map pin set on the web. A map pin picked while the
  // phone reports a mock position stays a proposal (flagged) for another look, exactly as for field staff.
  const direct = !deviceMock && (await canApprovePinIn(user, c.branchId));
  if (direct) return applyOfficePin(user, c, input, method, device, meta);
  const policy = await getSetting<string>('customers.staffPinApproval', c.branchId);
  const auto = policy === 'when_missing' && !hasUsablePin(c) && !deviceMock;
  const now = ctx().clock.now();
  try {
    const p = await LocationProposalModel.create({
      clientId: input.clientId,
      customerId,
      branchId: c.branchId,
      proposedBy: user.id,
      point: { type: 'Point', coordinates: [input.geo.lng, input.geo.lat] },
      accuracyM: input.geo.accuracyM,
      method,
      ...(device ? { devicePoint: { type: 'Point', coordinates: [device.lng, device.lat] }, deviceAccuracyM: device.accuracyM } : {}),
      deviceMock,
      photoMediaId: input.photoMediaId ?? null,
      note: input.note ?? null,
      ...(auto ? { status: 'approved', autoApplied: true, decidedAt: now } : {}),
    });
    const id = p._id.toHexString();
    await audit.record({
      actor: user,
      action: 'customer.location.proposed',
      entity: 'customer',
      entityId: customerId,
      branchId: c.branchId,
      after: { lat: input.geo.lat, lng: input.geo.lng, accuracyM: input.geo.accuracyM, method },
      meta,
    });
    if (auto) {
      const point = { type: 'Point' as const, coordinates: [input.geo.lng, input.geo.lat] };
      await applyPin(customerId, point, { approvedBy: null, approvedAt: now, proposalId: id, autoApplied: true });
      await audit.record({
        actor: user,
        action: 'customer.location.auto_applied',
        entity: 'customer',
        entityId: customerId,
        branchId: c.branchId,
        before: { location: c.location ?? null, status: c.locationStatus },
        after: { location: point, proposalId: id },
        reason: 'customer had no usable pin (customers.staffPinApproval = when_missing)',
        meta,
      });
      await ctx().bus.emit('customer.location.approved', { customerId, branchId: c.branchId, proposalId: id, autoApplied: true, proposedBy: user.id });
    } else {
      await ctx().bus.emit('customer.location.proposed', { proposalId: id, customerId, branchId: c.branchId, proposedBy: user.id });
    }
    // The proposer follows the proposal's fate on /sync/pull (contract 1.7.0).
    await recordChange({ entity: 'location_proposal', entityId: id, userIds: [user.id], branchId: c.branchId, fanoutBranchId: c.branchId });
    return { id, status: auto ? 'approved' : 'pending', replayed: false, direct: false };
  } catch (e) {
    if (isDuplicateKey(e)) return proposeLocation(user, customerId, input, meta);
    throw e;
  }
}

/**
 * Whether the caller holds `customer.location.approve` for this customer's branch. The permission key is checked
 * (never the role, CLAUDE.md §2.6) and evaluated for that one branch, so a branch override that denies it there wins.
 */
async function canApprovePinIn(user: AuthUser, branchId: string | null | undefined): Promise<boolean> {
  const subject = branchId ? { ...user, branchIds: [branchId] } : user;
  return (await ctx().ports.permissions?.(subject))?.has('customer.location.approve') ?? false;
}

/**
 * ADR-052: an approver's pin from the app. Stored like the web's direct set (`direct: true`, approved, decidedBy =
 * the caller) with the phone's fix kept for the history; audited `customer.location.set`; no `customer.location.proposed`
 * event, so nothing lands in the office inbox. The caller's devices and the branch learn it on /sync/pull.
 */
async function applyOfficePin(
  user: AuthUser,
  c: Doc,
  input: { clientId: string; geo: GeoInput; photoMediaId?: string | undefined; note?: string | undefined },
  method: 'gps' | 'map',
  device: GeoInput | null,
  meta: RequestMeta,
) {
  const customerId = (c._id as Types.ObjectId).toHexString();
  const now = ctx().clock.now();
  const point = { type: 'Point' as const, coordinates: [input.geo.lng, input.geo.lat] };
  let id: string;
  try {
    const p = await LocationProposalModel.create({
      clientId: input.clientId,
      customerId,
      branchId: c.branchId,
      proposedBy: user.id,
      point,
      accuracyM: input.geo.accuracyM,
      method,
      ...(device ? { devicePoint: { type: 'Point', coordinates: [device.lng, device.lat] }, deviceAccuracyM: device.accuracyM } : {}),
      deviceMock: false,
      photoMediaId: input.photoMediaId ?? null,
      note: input.note ?? null,
      direct: true,
      status: 'approved',
      decidedBy: user.id,
      decidedAt: now,
    });
    id = p._id.toHexString();
  } catch (e) {
    if (isDuplicateKey(e)) {
      const again = await LocationProposalModel.findOne({ clientId: input.clientId }).lean();
      if (again) return { id: again._id.toHexString(), status: again.status, replayed: true, direct: !!again.direct };
    }
    throw e;
  }
  await applyPin(customerId, point, { approvedBy: user.id, approvedAt: now, proposalId: id, direct: true });
  await recordChange({ entity: 'location_proposal', entityId: id, userIds: [user.id], branchId: c.branchId, fanoutBranchId: c.branchId });
  await audit.record({
    actor: user,
    action: 'customer.location.set',
    entity: 'customer',
    entityId: customerId,
    branchId: c.branchId,
    before: { location: c.location ?? null, status: c.locationStatus },
    after: { location: point, proposalId: id, method, accuracyM: input.geo.accuracyM, from: 'app' },
    reason: input.note ?? null,
    meta,
  });
  await ctx().bus.emit('customer.location.approved', { customerId, branchId: c.branchId, proposalId: id, direct: true, fromApp: true, proposedBy: user.id });
  return { id, status: 'approved', replayed: false, direct: true };
}

/**
 * FR-CUS-011: a manager drops the pin on the map and it becomes the customer's pin at once. Stored as an
 * already-approved proposal (`direct: true`) so pin history, the timeline and the approved tab need nothing new.
 * Idempotent by `clientId`. Pending staff proposals for the customer stay open: the manager decides them.
 */
export async function setLocation(
  user: AuthUser,
  customerId: string,
  input: { clientId: string; lat: number; lng: number; method?: 'map' | 'gps' | undefined; note?: string | undefined },
  meta: RequestMeta,
) {
  const c = await loadInScope(user, customerId);
  const existing = await LocationProposalModel.findOne({ clientId: input.clientId }).lean();
  if (existing) {
    if (existing.customerId !== customerId || !existing.direct) throw new AppError('INVALID_STATE', { reason: 'CLIENT_ID_REUSED' });
    return { id: existing._id.toHexString(), status: existing.status, replayed: true, location: locationView((await CustomerModel.findById(customerId).lean()) as Doc) };
  }
  if (classifyCoords(input.lat, input.lng) !== 'ok') throw businessRule('OUTSIDE_BANGLADESH');
  const now = ctx().clock.now();
  const point = { type: 'Point' as const, coordinates: [input.lng, input.lat] };
  let id: string;
  try {
    const p = await LocationProposalModel.create({
      clientId: input.clientId,
      customerId,
      branchId: c.branchId,
      proposedBy: user.id,
      point,
      accuracyM: null,
      method: input.method ?? 'map',
      direct: true,
      note: input.note ?? null,
      status: 'approved',
      decidedBy: user.id,
      decidedAt: now,
    });
    id = p._id.toHexString();
  } catch (e) {
    if (isDuplicateKey(e)) return setLocation(user, customerId, input, meta);
    throw e;
  }
  const { after } = await applyPin(customerId, point, { approvedBy: user.id, approvedAt: now, proposalId: id, direct: true });
  await recordChange({ entity: 'location_proposal', entityId: id, userIds: [], branchId: c.branchId, fanoutBranchId: c.branchId });
  await audit.record({
    actor: user,
    action: 'customer.location.set',
    entity: 'customer',
    entityId: customerId,
    branchId: c.branchId,
    before: { location: c.location ?? null, status: c.locationStatus },
    after: { location: point, proposalId: id },
    reason: input.note ?? null,
    meta,
  });
  await ctx().bus.emit('customer.location.approved', { customerId, branchId: c.branchId, proposalId: id, direct: true });
  return { id, status: 'approved', replayed: false, location: locationView(after) };
}

/**
 * 1.17.0 (owner request 2026-11-18): a manager deletes a customer's pin, whether it came from the ERP, the field or
 * the map. It is an overlay, not a data delete: `fos.locationOverride = { cleared: true }` keeps the ERP sync from
 * bringing the old coordinates back (ADR-036). The customer then counts as "no location" (data-quality list, staff
 * can drop a new pin that applies at once). Audited; pending staff proposals stay pending. Idempotent: deleting
 * a pin that is already gone changes nothing and says `removed: false`.
 */
export async function clearLocation(user: AuthUser, customerId: string, meta: RequestMeta) {
  const c = await loadInScope(user, customerId);
  const hadPin = hasUsablePin(c) || !!c.location?.coordinates?.length;
  if (!hadPin) return { removed: false, location: locationView(c) };
  const now = ctx().clock.now();
  const after = (await CustomerModel.findByIdAndUpdate(
    customerId,
    {
      $set: {
        'fos.locationOverride': { cleared: true, clearedBy: user.id, clearedAt: now },
        locationStatus: 'missing',
        locationSource: 'overlay',
      },
      $unset: { location: 1 },
      $inc: { version: 1 },
    },
    { new: true },
  ).lean()) as Doc;
  await recordChange(await customerFeed(customerId, after.branchId, [after.fos?.assigneeId]));
  await audit.record({
    actor: user,
    action: 'customer.location.cleared',
    entity: 'customer',
    entityId: customerId,
    branchId: c.branchId,
    before: { location: c.location ?? null, status: c.locationStatus, source: c.locationSource ?? 'erp' },
    after: { location: null, status: 'missing' },
    reason: null,
    meta,
  });
  await ctx().bus.emit('customer.location.cleared', { customerId, branchId: c.branchId });
  // A customer without a pin leaves its polygon area; the assignments module recomputes.
  if (after.branchId)
    await ctx().bus.emit('customer.placed', { customerId, branchId: after.branchId, areaCode: after.areaCode ?? null, isNew: false });
  return { removed: true, location: locationView(after) };
}

// ---------------- phone numbers added in FOS (FR-CUS-016, ADR-042) ----------------

const displayName = (u: AuthUser) => u.name.bn || u.name.en || u.employeeCode;

/**
 * Add one or more mobile numbers to a customer. They are kept in the FOS overlay only: nothing is
 * sent to the ERP and the ERP sync never removes them. A number the customer already has is skipped,
 * so a repeat of the same request changes nothing. One invalid number refuses the whole request.
 */
export async function addPhones(user: AuthUser, customerId: string, input: PhoneInput[], meta: RequestMeta) {
  const c = await loadInScope(user, customerId);
  const extra = (c.fos?.extraPhones ?? []) as ExtraPhone[];
  const plan = planAdd((c.phones ?? []) as string[], extra, input);
  if (plan.invalid.length)
    throw new AppError('VALIDATION_FAILED', {
      fields: plan.invalid.map((x) => ({ path: `phones.${x.index}.number`, message: 'Bangladesh mobile number, 01XXXXXXXXX' })),
    });
  if (!plan.add.length) return { added: [] as string[], skipped: plan.skipped, ...phonesView(c) };
  const now = ctx().clock.now();
  const rows: ExtraPhone[] = plan.add.map((a) => ({ number: a.number, label: a.label, addedBy: user.id, addedByName: displayName(user), addedAt: now }));
  // Guarded by the count so two requests at once cannot pass the limit together.
  const after = (await CustomerModel.findOneAndUpdate(
    { _id: customerId, 'fos.extraPhones.number': { $nin: rows.map((r) => r.number) }, [`fos.extraPhones.${MAX_EXTRA_PHONES - rows.length}`]: { $exists: false } },
    { $push: { 'fos.extraPhones': { $each: rows } }, $inc: { version: 1 } },
    { new: true },
  ).lean()) as Doc | null;
  if (!after) {
    // Another request added a number in between: answer from what is stored now.
    const fresh = await loadInScope(user, customerId);
    const have = new Set(phoneList(fresh).map((p) => p.number));
    const full = ((fresh.fos?.extraPhones ?? []) as ExtraPhone[]).length >= MAX_EXTRA_PHONES;
    return {
      added: [] as string[],
      skipped: [...plan.skipped, ...plan.add.map((a) => ({ number: a.number, reason: have.has(a.number) ? ('duplicate' as const) : full ? ('limit' as const) : ('duplicate' as const) }))],
      ...phonesView(fresh),
    };
  }
  await recordChange(await customerFeed(customerId, after.branchId, [after.fos?.assigneeId]));
  await audit.record({
    actor: user,
    action: 'customer.phone.added',
    entity: 'customer',
    entityId: customerId,
    branchId: c.branchId,
    before: { added: extra.length },
    // Numbers are personal data: the log keeps how many and the last four digits only.
    after: { added: extra.length + rows.length, numbers: rows.map((r) => `…${r.number.slice(-4)}`) },
    reason: null,
    meta,
  });
  return { added: rows.map((r) => r.number), skipped: plan.skipped, ...phonesView(after) };
}

/**
 * Remove a number that was added in FOS. An ERP number cannot be removed here (the office owns it).
 * Idempotent: a number that is not there answers `removed: false`.
 */
export async function removePhone(user: AuthUser, customerId: string, raw: string, meta: RequestMeta) {
  const c = await loadInScope(user, customerId);
  const number = normalizeMobile(raw);
  if (!number) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'number', message: 'Bangladesh mobile number, 01XXXXXXXXX' }] });
  const extra = (c.fos?.extraPhones ?? []) as ExtraPhone[];
  if (!extra.some((e) => e.number === number)) {
    if (((c.phones ?? []) as string[]).includes(number)) throw businessRule('PHONE_FROM_ERP');
    return { removed: false, ...phonesView(c) };
  }
  const after = (await CustomerModel.findByIdAndUpdate(
    customerId,
    { $pull: { 'fos.extraPhones': { number } }, $inc: { version: 1 } },
    { new: true },
  ).lean()) as Doc;
  await recordChange(await customerFeed(customerId, after.branchId, [after.fos?.assigneeId]));
  await audit.record({
    actor: user,
    action: 'customer.phone.removed',
    entity: 'customer',
    entityId: customerId,
    branchId: c.branchId,
    before: { added: extra.length, numbers: [`…${number.slice(-4)}`] },
    after: { added: extra.length - 1 },
    reason: null,
    meta,
  });
  return { removed: true, ...phonesView(after) };
}

export async function listProposals(user: AuthUser, q: { branchId?: string; status?: string }) {
  const rows = await LocationProposalModel.find({ ...branchQuery(user, q.branchId), status: q.status ?? 'pending' })
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();
  const refs = await getCustomerRefs(rows.map((r) => r.customerId));
  const people = await getUsers([...rows.map((r) => r.proposedBy ?? ''), ...rows.map((r) => r.decidedBy ?? '')].filter(Boolean));
  const nameOf = (id: string) => {
    const u = people.get(id);
    return u ? u.name.en || u.name.bn : '';
  };
  return rows.map((p) => {
    const at = { lat: p.point!.coordinates[1]!, lng: p.point!.coordinates[0]! };
    const dev = p.devicePoint?.coordinates?.length === 2 ? { lat: p.devicePoint.coordinates[1]!, lng: p.devicePoint.coordinates[0]! } : null;
    return {
      id: p._id.toHexString(),
      customer: refs.get(p.customerId)
        ? {
            id: p.customerId,
            name: refs.get(p.customerId)!.name,
            code: refs.get(p.customerId)!.code,
            current: refs.get(p.customerId)!.location,
          }
        : { id: p.customerId },
      lat: at.lat,
      lng: at.lng,
      ...(typeof p.accuracyM === 'number' ? { accuracyM: p.accuracyM } : {}),
      photoMediaId: p.photoMediaId,
      note: p.note,
      proposedBy: p.proposedBy,
      proposer: { id: p.proposedBy ?? '', name: nameOf(p.proposedBy ?? '') },
      status: p.status,
      method: (p.method ?? 'gps') as 'gps' | 'map',
      deviceDistanceM: dev ? Math.round(haversineM(at, dev)) : null,
      deviceMock: !!p.deviceMock,
      autoApplied: !!p.autoApplied,
      direct: !!p.direct,
      decider: p.decidedBy ? { id: p.decidedBy, name: nameOf(p.decidedBy) } : null,
      decidedAt: p.decidedAt ? p.decidedAt.toISOString() : null,
      createdAt: (p as unknown as { createdAt: Date }).createdAt.toISOString(),
    };
  });
}

/** What the proposing staff member sees of their own proposal (sync entity `location_proposal`, contract 1.7.0). */
function ownProposalView(p: LooseObject, nameOf: (id: string) => string = () => '') {
  return {
    proposer: { id: (p.proposedBy ?? '') as string, name: nameOf(p.proposedBy ?? '') },
    decider: p.decidedBy ? { id: p.decidedBy as string, name: nameOf(p.decidedBy) } : null,
    direct: !!p.direct,
    id: p._id.toHexString() as string,
    clientId: p.clientId as string,
    customerId: p.customerId as string,
    status: p.status as string,
    lat: p.point.coordinates[1] as number,
    lng: p.point.coordinates[0] as number,
    accuracyM: (p.accuracyM ?? 0) as number,
    note: (p.note ?? null) as string | null,
    decisionReason: (p.decisionReason ?? null) as string | null,
    method: (p.method ?? 'gps') as string,
    autoApplied: !!p.autoApplied,
    createdAt: (p.createdAt as Date).toISOString(),
    decidedAt: p.decidedAt ? (p.decidedAt as Date).toISOString() : null,
  };
}

/** Proposals with the names of who proposed and who decided (contract 1.31.0). */
async function proposalViews(rows: LooseObject[]) {
  const people = await getUsers([...rows.map((r) => r.proposedBy ?? ''), ...rows.map((r) => r.decidedBy ?? '')].filter(Boolean));
  const nameOf = (id: string) => {
    const u = people.get(id);
    return u ? u.name.en || u.name.bn : '';
  };
  return rows.map((r) => ownProposalView(r, nameOf));
}

/** Own proposals, newest first (after a reinstall the app has no sync history to learn them from). */
export async function myProposals(user: AuthUser, status?: string) {
  const rows = (await LocationProposalModel.find({ proposedBy: user.id, direct: { $ne: true }, ...(status ? { status } : {}) }).sort({ createdAt: -1 }).limit(200).lean()) as LooseObject[];
  return proposalViews(rows);
}

/**
 * Bootstrap for the `location_proposal` sync entity (ADR-046): the pins proposed or set in the user's branches, so every
 * device can say who pinned a customer. Pending ones plus those of the last 60 days, newest first, at most 500.
 */
export async function branchProposalsSnapshot(user: AuthUser) {
  const since = new Date(ctx().clock.now().getTime() - 60 * 86_400_000);
  const rows = (await LocationProposalModel.find({ branchId: { $in: user.branchIds }, $or: [{ status: 'pending' }, { createdAt: { $gte: since } }] })
    .sort({ createdAt: -1 })
    .limit(500)
    .lean()) as LooseObject[];
  return { items: await proposalViews(rows), nextCursor: null };
}

/** Sync loader: a proposal reaches the devices of its branch (every loader applies the caller's scope); other branches resolve to nothing. */
export async function proposalSyncLoad(ids: string[], user: AuthUser): Promise<Map<string, Record<string, unknown>>> {
  const rows = (await LocationProposalModel.find({ _id: { $in: ids.filter(isOid) }, branchId: { $in: user.branchIds } }).lean()) as LooseObject[];
  const views = await proposalViews(rows);
  return new Map(views.map((v) => [v.id, v]));
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
  await recordChange({ entity: 'location_proposal', entityId: id, userIds: p.proposedBy ? [p.proposedBy] : [], branchId: p.branchId ?? null, fanoutBranchId: p.branchId ?? null });
  if (input.decision === 'approve') {
    const { before } = await applyPin(p.customerId, p.point as { type: 'Point'; coordinates: number[] }, { approvedBy: user.id, approvedAt: now, proposalId: id });
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

export interface QualityRow {
  customerId: string;
  code: string;
  name: { bn: string; en: string };
  branchId: string;
  areaCode: string | null;
  assigneeId: string | null;
  findings: Finding[];
}

/**
 * FR-CUS-009: every active customer matching `filter` with its data problems, ordered by id.
 * One scan per request: plans are reduced to their schedule size in the database, so schedules
 * never leave MongoDB.
 */
/** `maxKmFor` gives the far_from_branch distance of a branch (a setting a branch may override). */
export async function dataQualityScan(filter: Record<string, unknown>, maxKmFor: (branchId: string) => Promise<number>): Promise<QualityRow[]> {
  const docs = await CustomerModel.aggregate<LooseObject>([
    { $match: { ...filter, erpStatus: 'active' } },
    { $sort: { _id: 1 } },
    {
      $project: {
        code: 1, name: 1, branchId: 1, areaCode: 1, phones: 1, locationStatus: 1, location: 1, erpLocation: 1, assigneeId: '$fos.assigneeId',
        plans: { $map: { input: { $ifNull: ['$plans', []] }, as: 'p', in: { erpPlanId: '$$p.erpPlanId', status: '$$p.status', outstandingPoisha: { $ifNull: ['$$p.outstandingPoisha', 0] }, scheduleLines: { $size: { $ifNull: ['$$p.schedule', []] } } } } },
      },
    },
  ]);
  const branchIds = [...new Set(docs.map((d) => d.branchId as string).filter(Boolean))];
  const branches = await getBranches(branchIds);
  const maxKm = new Map(await Promise.all(branchIds.map(async (id) => [id, await maxKmFor(id)] as const)));
  const inputs: QualityInput[] = docs.map((d) => ({
    id: d._id.toHexString(),
    code: d.code ?? '',
    branchId: d.branchId ?? '',
    locationStatus: d.locationStatus ?? 'missing',
    location: d.location?.coordinates?.length === 2 ? { lat: d.location.coordinates[1], lng: d.location.coordinates[0] } : null,
    erpLocation: d.erpLocation ?? null,
    phones: (d.phones ?? []) as string[],
    assigneeId: d.assigneeId ?? null,
    plans: (d.plans ?? []) as QualityInput['plans'],
  }));
  const shared = sharedPhones(inputs);
  return inputs.map((c, i) => {
    const b = branches.get(c.branchId);
    const findings = findIssues(c, b && b.lat !== null && b.lng !== null ? { lat: b.lat, lng: b.lng } : null, maxKm.get(c.branchId) ?? Infinity);
    const others = shared.get(c.id);
    if (others) findings.push({ issue: 'shared_phone', detail: `Same number as ${others.slice(0, 3).join(', ')}${others.length > 3 ? ` and ${others.length - 3} more` : ''}` });
    findings.sort((a, b) => QUALITY_ISSUES.indexOf(a.issue) - QUALITY_ISSUES.indexOf(b.issue));
    const d = docs[i]!;
    return { customerId: c.id, code: c.code, name: { bn: d.name?.bn ?? '', en: d.name?.en ?? '' }, branchId: c.branchId, areaCode: d.areaCode ?? null, assigneeId: c.assigneeId, findings };
  });
}
