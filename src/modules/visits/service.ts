import { z } from 'zod';
import { ctx } from '../../core/context/index.js';
import { AppError, notFound } from '../../core/errors/index.js';
import { isDuplicateKey, isOid, type LeanDoc } from '../../core/db/index.js';
import { recordChange } from '../../core/changefeed/index.js';
import { decodeCursor, encodeCursor } from '../../core/http/index.js';
import { haversineM } from '../../core/geo/index.js';
import { addDays, businessDate, dhakaMinuteOfDay, startOfBusinessDay } from '../../core/time/index.js';
import { branchQuery, canSeeBranch, isSuperAdmin, type AuthUser } from '../../core/security/types.js';
import { getSetting } from '../settings/index.js';
import { getUsers } from '../users/index.js';
import { getCustomerRef, getCustomerRefs, type ActivityPerson, type TimelineItem } from '../customers/index.js';
import { VisitModel } from './models/visit.model.js';

type Lean = LeanDoc;
export const OUTCOMES = ['paid', 'partial_paid', 'promised', 'not_home', 'refused', 'shifted_address', 'customer_dead', 'product_returned_request', 'runaway', 'other'] as const;
const OUTCOME_BN: Record<string, string> = { paid: 'পরিশোধ', partial_paid: 'আংশিক পরিশোধ', promised: 'প্রতিশ্রুতি', not_home: 'বাড়িতে নেই', refused: 'অস্বীকার', shifted_address: 'ঠিকানা পরিবর্তন', customer_dead: 'মৃত', product_returned_request: 'পণ্য ফেরতের অনুরোধ', runaway: 'পলাতক', other: 'অন্যান্য' };

const geoFix = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().min(0), mock: z.boolean().default(false), fixAt: z.string().optional() });
export const createSchema = z.object({
  clientId: z.string().uuid(),
  customerId: z.string().max(64),
  checkInAt: z.string().datetime({ offset: true }),
  deviceTime: z.string().datetime({ offset: true }).optional(),
  outcome: z.enum(OUTCOMES),
  geo: geoFix.nullable(),
  geoUnavailableReason: z.enum(['permission_denied', 'location_off', 'timeout', 'no_fix']).optional(),
  photoMediaIds: z.array(z.string().max(64)).max(5).default([]),
  source: z.enum(['manual', 'suggested']).default('manual'),
  coWorkSessionId: z.string().max(64).optional(),
});

/** Port filled by the cowork module: the other session members working with the recorder at that instant, or null when the recorder was not one. */
export type CoWorkResolver = (recorderId: string, sessionId: string, at: Date) => Promise<string[] | null>;
let coWorkResolver: CoWorkResolver | null = null;
export const registerCoWorkResolver = (fn: CoWorkResolver) => void (coWorkResolver = fn);

export function scopeFilter(user: AuthUser): Record<string, unknown> {
  if (isSuperAdmin(user)) return {};
  // A partner of a joint visit sees it too (FR-CW-003).
  if (user.role === 'field_staff') return { $or: [{ userId: user.id }, { 'coWork.participantIds': user.id }] };
  return { branchId: { $in: user.branchIds } };
}

/**
 * Who may READ a visit (FR-ACT-002, ADR-046): staff see every visit of their branches, each with the name of who made
 * it. Writing stays with the recorder (`checkout` matches `userId`), never this filter.
 */
export function readScope(user: AuthUser): Record<string, unknown> {
  return isSuperAdmin(user) ? {} : { branchId: { $in: user.branchIds } };
}

function view(v: Lean) {
  return {
    id: v._id.toHexString(),
    clientId: v.clientId,
    customerId: v.customerId,
    userId: v.userId,
    checkInAt: (v.checkInAt as Date).toISOString(),
    checkOutAt: v.checkOutAt ? (v.checkOutAt as Date).toISOString() : null,
    outcome: v.outcome,
    geo: v.geo?.point ? { lat: v.geo.point.coordinates[1], lng: v.geo.point.coordinates[0], accuracyM: v.geo.accuracyM, mock: !!v.geo.mock } : null,
    photoMediaIds: v.photoMediaIds ?? [],
    source: v.source,
    distanceToPinM: v.geo?.distanceToPinM ?? null,
    flags: v.flags ?? [],
    coWork: v.coWork?.sessionId ? { sessionId: v.coWork.sessionId as string, participantIds: (v.coWork.participantIds ?? []) as string[] } : null,
  };
}

/** The visit with the display name of who recorded it (`userName`, contract 1.31.0). */
async function namedAll(rows: Lean[]) {
  const users = await getUsers(rows.map((r) => r.userId));
  return rows.map((v) => {
    const u = users.get(v.userId);
    return { ...view(v), userName: u ? u.name.en || u.name.bn : '' };
  });
}
const named = async (v: Lean) => (await namedAll([v]))[0]!;

/** FR-VIS-001. Idempotent by clientId (offline retries); the visit never waits for its photos (FR-VIS-003). */
export async function create(user: AuthUser, input: z.infer<typeof createSchema>): Promise<{ statusCode: 200 | 201; body: Awaited<ReturnType<typeof named>> }> {
  const prior = (await VisitModel.findOne({ clientId: input.clientId }).lean()) as Lean | null;
  if (prior) {
    if (prior.userId !== user.id) throw new AppError('IDEMPOTENCY_MISMATCH', { clientId: input.clientId });
    return { statusCode: 200, body: await named(prior) };
  }
  const c = await getCustomerRef(null, input.customerId);
  if (!c?.branchId || !canSeeBranch(user, c.branchId)) throw notFound('customer');
  const geo = input.geo;
  const distanceToPinM = c.location && geo ? Math.round(haversineM(c.location, { lat: geo.lat, lng: geo.lng })) : null;
  const flags: string[] = [];
  if (distanceToPinM !== null && distanceToPinM > ((await getSetting<number>('collections.geofenceM', c.branchId)) ?? 300)) flags.push('far_from_pin');
  if (geo?.mock) flags.push('mock_location');
  if (!geo) flags.push('no_location');
  if (user.role === 'field_staff' && c.assigneeId !== user.id) flags.push('not_in_scope_at_record_time');
  // FR-CW-003: the server decides who took part; a claim it cannot confirm is kept as a single visit and flagged.
  let coWork: { sessionId: string; participantIds: string[] } | null = null;
  if (input.coWorkSessionId) {
    const partners = coWorkResolver ? await coWorkResolver(user.id, input.coWorkSessionId, new Date(input.checkInAt)) : null;
    if (!partners) flags.push('cowork_invalid');
    else if (partners.length) coWork = { sessionId: input.coWorkSessionId, participantIds: partners };
  }
  try {
    const v = await VisitModel.create({
      clientId: input.clientId,
      branchId: c.branchId,
      customerId: c.id,
      userId: user.id,
      checkInAt: new Date(input.checkInAt),
      deviceTime: input.deviceTime ? new Date(input.deviceTime) : null,
      receivedAt: ctx().clock.now(),
      outcome: input.outcome,
      geo: geo ? { point: { type: 'Point', coordinates: [geo.lng, geo.lat] }, accuracyM: geo.accuracyM, mock: geo.mock, distanceToPinM } : null,
      geoUnavailableReason: geo ? null : (input.geoUnavailableReason ?? 'no_fix'),
      photoMediaIds: input.photoMediaIds,
      source: input.source,
      flags,
      coWork,
    });
    const lean = v.toObject() as Lean;
    await recordChange({ entity: 'visit', entityId: lean._id.toHexString(), userIds: [user.id, ...(coWork?.participantIds ?? [])], branchId: c.branchId, fanoutBranchId: c.branchId });
    await ctx().bus.emit('visit.recorded', { visitId: lean._id.toHexString(), customerId: c.id, branchId: c.branchId, userId: user.id, outcome: input.outcome, flags });
    return { statusCode: 201, body: await named(lean) };
  } catch (e) {
    if (isDuplicateKey(e)) return create(user, input);
    throw e;
  }
}

/** Resolve the server id of the caller's own visit from the id the app generated offline. */
export async function idByClientId(user: AuthUser, clientId: string): Promise<string> {
  const v = (await VisitModel.findOne({ clientId, userId: user.id }).select({ _id: 1 }).lean()) as Lean | null;
  if (!v) throw notFound('visit');
  return v._id.toHexString();
}

export async function checkout(user: AuthUser, id: string, input: { checkOutAt: string; outcome?: (typeof OUTCOMES)[number] | undefined }) {
  if (!isOid(id)) throw notFound('visit');
  const v = (await VisitModel.findOne({ _id: id, userId: user.id }).lean()) as Lean | null;
  if (!v) throw notFound('visit');
  const at = new Date(input.checkOutAt);
  if (at < v.checkInAt) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'checkOutAt', message: 'before check-in' }] });
  if (v.checkOutAt) return named(v); // idempotent
  await VisitModel.updateOne({ _id: id }, { $set: { checkOutAt: at, ...(input.outcome ? { outcome: input.outcome } : {}) } });
  await recordChange({ entity: 'visit', entityId: id, userIds: [user.id, ...((v.coWork?.participantIds ?? []) as string[])], branchId: v.branchId, fanoutBranchId: v.branchId });
  return named((await VisitModel.findById(id).lean()) as Lean);
}

/** Dhaka wall-clock "HH:mm" (24 h) of an instant. */
function dhakaHhmm(at: Date): string {
  const m = dhakaMinuteOfDay(at);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** List rows carry display refs so admin tables need no extra calls (contract 1.4.0). */
async function withRefs(rows: Lean[]) {
  const refs = await getCustomerRefs(rows.map((r) => r.customerId));
  const users = await getUsers(rows.flatMap((r) => [r.userId, ...((r.coWork?.participantIds ?? []) as string[])]));
  const nameOf = (id: string) => {
    const p = users.get(id);
    return p ? p.name.en || p.name.bn : '';
  };
  return rows.map((v) => {
    const ref = refs.get(v.customerId);
    const u = users.get(v.userId);
    // 1.45.0: the Dhaka day and time of the check-in, so tables need not convert.
    const base = { ...view(v), userName: u ? u.name.en || u.name.bn : '', businessDate: businessDate(v.checkInAt as Date), checkInLocalTime: dhakaHhmm(v.checkInAt as Date) };
    return { ...base, coWork: base.coWork ? { ...base.coWork, participants: base.coWork.participantIds.map((id) => ({ id, name: nameOf(id) })) } : null, customer: { id: v.customerId, name: ref?.name ?? { bn: '', en: '' }, code: ref?.code ?? '' }, user: { id: v.userId, name: u ? u.name.en || u.name.bn : '' } };
  });
}

export async function list(user: AuthUser, q: { branchId?: string | undefined; userId?: string | undefined; customerId?: string | undefined; date?: string | undefined; from?: string | undefined; to?: string | undefined; outcome?: string | undefined; coWork?: 'true' | 'false' | undefined; coWorkSessionId?: string | undefined; limit: number; cursor?: string | undefined }) {
  const f: Record<string, unknown> = { ...(q.branchId ? branchQuery(user, q.branchId) : {}) };
  const and: Record<string, unknown>[] = [readScope(user)];
  // A person's visits include the joint visits they took part in without recording them (1.9.0).
  if (q.userId && user.role !== 'field_staff') and.push({ $or: [{ userId: q.userId }, { 'coWork.participantIds': q.userId }] });
  if (q.coWork) f['coWork.sessionId'] = q.coWork === 'true' ? { $ne: null } : null;
  if (q.coWorkSessionId) f['coWork.sessionId'] = q.coWorkSessionId;
  f.$and = and;
  if (q.customerId) f.customerId = q.customerId;
  // `date` is one Dhaka business day; `from`/`to` (inclusive Dhaka days) are ignored when `date` is given.
  const from = q.date ?? q.from;
  const to = q.date ?? q.to;
  if (from || to) f.checkInAt = { ...(from ? { $gte: new Date(`${from}T00:00:00+06:00`) } : {}), ...(to ? { $lte: new Date(`${to}T23:59:59.999+06:00`) } : {}) };
  if (q.outcome) f.outcome = q.outcome;
  const cur = decodeCursor<{ id: string }>(q.cursor);
  const rows = (await VisitModel.find({ ...f, ...(cur ? { _id: { $lt: cur.id } } : {}) }).sort({ _id: -1 }).limit(q.limit + 1).lean()) as Lean[];
  const items = rows.slice(0, q.limit);
  return { items: await withRefs(items), nextCursor: rows.length > q.limit ? encodeCursor({ id: items[items.length - 1]!._id.toHexString() }) : null };
}

export async function get(user: AuthUser, id: string) {
  if (!isOid(id)) throw notFound('visit');
  const v = (await VisitModel.findOne({ _id: id, ...readScope(user) }).lean()) as Lean | null;
  if (!v) throw notFound('visit');
  return named(v);
}

/** How far back a fresh device receives the branch's visits, promises and collections (ADR-046). */
export const ACTIVITY_DAYS = 60;

/** Bootstrap for a fresh device: the last 60 Dhaka days of visits in the user's branches, paged by id. */
export async function syncSnapshot(user: AuthUser, cursor: string | null, limit: number) {
  const c = decodeCursor<{ id: string }>(cursor ?? undefined);
  const date = businessDate(ctx().clock.now());
  const rows = (await VisitModel.find({ ...readScope(user), checkInAt: range(addDays(date, -ACTIVITY_DAYS), date), ...(c ? { _id: { $gt: c.id } } : {}) }).sort({ _id: 1 }).limit(limit + 1).lean()) as Lean[];
  const page = rows.slice(0, limit);
  return { items: await namedAll(page), nextCursor: rows.length > limit ? encodeCursor({ id: page[page.length - 1]!._id.toHexString() }) : null };
}

/** The last visit of each customer and (1.44.0) the name of who made it. */
export async function lastVisits(customerIds: string[]): Promise<Map<string, { at: Date; byName: string | null }>> {
  const rows = await VisitModel.aggregate<{ _id: string; at: Date; userId: string }>([
    { $match: { customerId: { $in: customerIds } } },
    { $sort: { checkInAt: -1 } },
    { $group: { _id: '$customerId', at: { $first: '$checkInAt' }, userId: { $first: '$userId' } } },
  ]);
  const users = await getUsers([...new Set(rows.map((r) => r.userId))]);
  return new Map(
    rows.map((r) => {
      const u = users.get(r.userId);
      return [r._id, { at: r.at, byName: u ? u.name.en || u.name.bn || null : null }];
    }),
  );
}

/**
 * 1.24.0 (FR-CUS-017): visits of the current Dhaka month per customer: how many, the last one, and whether one is today.
 * 1.44.0 (FR-CUS-021): `by` = who visited, one entry per staff member (count and last visit), newest first.
 */
export async function monthVisits(
  customerIds: string[],
): Promise<Map<string, { count: number; lastAt: string | null; today: boolean; by: ActivityPerson[] }>> {
  const date = businessDate(ctx().clock.now());
  const from = startOfBusinessDay(`${date.slice(0, 7)}-01`);
  const day = startOfBusinessDay(date);
  const rows = await VisitModel.aggregate<{ _id: { c: string; u: string }; count: number; lastAt: Date; today: number }>([
    { $match: { customerId: { $in: customerIds }, checkInAt: { $gte: from } } },
    { $group: { _id: { c: '$customerId', u: '$userId' }, count: { $sum: 1 }, lastAt: { $max: '$checkInAt' }, today: { $sum: { $cond: [{ $gte: ['$checkInAt', day] }, 1, 0] } } } },
  ]);
  const users = await getUsers([...new Set(rows.map((r) => r._id.u))]);
  const out = new Map<string, { count: number; lastAt: string | null; today: boolean; by: ActivityPerson[] }>();
  for (const r of rows) {
    const x = out.get(r._id.c) ?? { count: 0, lastAt: null, today: false, by: [] };
    const at = r.lastAt.toISOString();
    x.count += r.count;
    if (!x.lastAt || at > x.lastAt) x.lastAt = at;
    x.today ||= r.today > 0;
    const u = users.get(r._id.u);
    x.by.push({ userId: r._id.u, name: u ? u.name.en || u.name.bn : '', count: r.count, lastAt: at });
    out.set(r._id.c, x);
  }
  for (const x of out.values()) x.by.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  return out;
}

export async function lastVisitOf(customerId: string) {
  const v = (await VisitModel.findOne({ customerId }).sort({ checkInAt: -1 }).lean()) as Lean | null;
  return v ? view(v) : null;
}

export async function timelineItems(customerId: string, before: Date | null, limit: number): Promise<TimelineItem[]> {
  const rows = (await VisitModel.find({ customerId, ...(before ? { checkInAt: { $lt: before } } : {}) }).sort({ checkInAt: -1 }).limit(limit).lean()) as Lean[];
  const users = await getUsers(rows.map((r) => r.userId));
  return rows.map((v) => {
    const u = users.get(v.userId);
    return {
      kind: 'visit',
      at: (v.checkInAt as Date).toISOString(),
      ...(u ? { actor: { id: u.id, name: u.name.en || u.name.bn } } : {}),
      summary: { en: `Visit: ${v.outcome.replace(/_/g, ' ')}`, bn: `ভিজিট: ${OUTCOME_BN[v.outcome] ?? v.outcome}` },
      refId: v._id.toHexString(),
      data: { flags: v.flags, photos: (v.photoMediaIds ?? []).length },
    };
  });
}

/** Visit count and unique customers per Dhaka business day in the caller's scope (dashboard). */
export async function visitsByDay(user: AuthUser, branchId: string | undefined, from: string, to: string) {
  const rows = await VisitModel.aggregate<{ _id: string; n: number; c: string[] }>([
    { $match: { ...scopeFilter(user), ...(branchId ? branchQuery(user, branchId) : {}), checkInAt: { $gte: new Date(`${from}T00:00:00+06:00`), $lte: new Date(`${to}T23:59:59.999+06:00`) } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$checkInAt', timezone: 'Asia/Dhaka' } }, n: { $sum: 1 }, c: { $addToSet: '$customerId' } } },
  ]);
  return new Map(rows.map((r) => [r._id, { count: r.n, uniqueCustomers: r.c.length }]));
}

/** Per-staff visit counts for reports (FR-REP-001). */
export async function visitsByUser(user: AuthUser, branchId: string | undefined, from: string, to: string) {
  const rows = await VisitModel.aggregate<{ _id: string; n: number; c: string[] }>([
    { $match: { ...scopeFilter(user), ...(branchId ? branchQuery(user, branchId) : {}), checkInAt: { $gte: new Date(`${from}T00:00:00+06:00`), $lte: new Date(`${to}T23:59:59.999+06:00`) } } },
    { $group: { _id: '$userId', n: { $sum: 1 }, c: { $addToSet: '$customerId' } } },
  ]);
  return new Map(rows.map((r) => [r._id, { count: r.n, uniqueCustomers: r.c.length }]));
}

/** One staff member's visits of a business date, oldest first (route-history overlay, stop ↔ visit link). */
export async function visitsOfUserDay(userId: string, date: string) {
  const rows = (await VisitModel.find({ userId, checkInAt: { $gte: new Date(`${date}T00:00:00+06:00`), $lte: new Date(`${date}T23:59:59.999+06:00`) } }).sort({ checkInAt: 1 }).lean()) as Lean[];
  return rows.map((v) => ({
    id: v._id.toHexString() as string,
    customerId: v.customerId as string,
    checkInAt: v.checkInAt as Date,
    outcome: v.outcome as string,
    lat: (v.geo?.point?.coordinates?.[1] ?? null) as number | null,
    lng: (v.geo?.point?.coordinates?.[0] ?? null) as number | null,
  }));
}

/** Visit counts of a business date for the given staff (live-map marker). */
export async function visitCountsOfDay(userIds: string[], date: string): Promise<Map<string, number>> {
  const rows = await VisitModel.aggregate<{ _id: string; n: number }>([
    { $match: { userId: { $in: userIds }, checkInAt: { $gte: new Date(`${date}T00:00:00+06:00`), $lte: new Date(`${date}T23:59:59.999+06:00`) } } },
    { $group: { _id: '$userId', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [r._id, r.n]));
}

const range = (from: string, to: string) => ({ $gte: new Date(`${from}T00:00:00+06:00`), $lte: new Date(`${to}T23:59:59.999+06:00`) });

/**
 * FR-CW-005: single visits per recorder, and joint visits per person who took part (recorder or
 * partner). Two members recording the same customer in the same session is one joint visit, so
 * nobody is credited twice for one stop.
 */
export async function visitSplitByUser(user: AuthUser, branchId: string | undefined, from: string, to: string): Promise<Map<string, { solo: number; coWork: number }>> {
  const match = { ...scopeFilter(user), ...(branchId ? branchQuery(user, branchId) : {}), checkInAt: range(from, to) };
  const out = new Map<string, { solo: number; coWork: number }>();
  const row = (id: string) => out.get(id) ?? out.set(id, { solo: 0, coWork: 0 }).get(id)!;
  const solo = await VisitModel.aggregate<{ _id: string; n: number }>([{ $match: { ...match, 'coWork.sessionId': null } }, { $group: { _id: '$userId', n: { $sum: 1 } } }]);
  for (const r of solo) row(r._id).solo = r.n;
  const joint = await VisitModel.aggregate<{ _id: string; n: number }>([
    { $match: { ...match, 'coWork.sessionId': { $ne: null } } },
    { $project: { sessionId: '$coWork.sessionId', customerId: 1, person: { $concatArrays: [['$userId'], '$coWork.participantIds'] } } },
    { $unwind: '$person' },
    { $group: { _id: { person: '$person', sessionId: '$sessionId', customerId: '$customerId' } } },
    { $group: { _id: '$_id.person', n: { $sum: 1 } } },
  ]);
  for (const r of joint) row(r._id).coWork = r.n;
  return out;
}

/** Joint visits per co-work session (one per customer), for the manager's session list. */
export async function coWorkVisitCounts(sessionIds: string[]): Promise<Map<string, number>> {
  if (!sessionIds.length) return new Map();
  const rows = await VisitModel.aggregate<{ _id: string; n: number }>([
    { $match: { 'coWork.sessionId': { $in: sessionIds } } },
    { $group: { _id: { sessionId: '$coWork.sessionId', customerId: '$customerId' } } },
    { $group: { _id: '$_id.sessionId', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [r._id, r.n]));
}

/** FR-REP-005 self-view: one person's single and joint visits per Dhaka day (joint = one per session and customer). */
export async function visitSplitByDay(userId: string, from: string, to: string): Promise<Map<string, { recorded: number; solo: number; coWork: number }>> {
  const day = { $dateToString: { format: '%Y-%m-%d', date: '$checkInAt', timezone: 'Asia/Dhaka' } };
  const out = new Map<string, { recorded: number; solo: number; coWork: number }>();
  const row = (d: string) => out.get(d) ?? out.set(d, { recorded: 0, solo: 0, coWork: 0 }).get(d)!;
  const own = await VisitModel.aggregate<{ _id: { d: string; joint: boolean }; n: number }>([
    { $match: { userId, checkInAt: range(from, to) } },
    { $group: { _id: { d: day, joint: { $ne: [{ $ifNull: ['$coWork.sessionId', null] }, null] } }, n: { $sum: 1 } } },
  ]);
  for (const r of own) {
    row(r._id.d).recorded += r.n;
    if (!r._id.joint) row(r._id.d).solo += r.n;
  }
  const joint = await VisitModel.aggregate<{ _id: string; n: number }>([
    { $match: { $or: [{ userId }, { 'coWork.participantIds': userId }], 'coWork.sessionId': { $ne: null }, checkInAt: range(from, to) } },
    { $group: { _id: { d: day, s: '$coWork.sessionId', c: '$customerId' } } },
    { $group: { _id: '$_id.d', n: { $sum: 1 } } },
  ]);
  for (const r of joint) row(r._id).coWork = r.n;
  return out;
}
