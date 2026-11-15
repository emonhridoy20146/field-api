import { z } from 'zod';
import { ctx } from '../../core/context/index.js';
import { AppError, notFound } from '../../core/errors/index.js';
import { isDuplicateKey, isOid } from '../../core/db/index.js';
import { recordChange } from '../../core/changefeed/index.js';
import { decodeCursor, encodeCursor } from '../../core/http/index.js';
import { haversineM } from '../../core/geo/index.js';
import { branchQuery, canSeeBranch, isSuperAdmin, type AuthUser } from '../../core/security/types.js';
import { getSetting } from '../settings/index.js';
import { getUsers } from '../users/index.js';
import { getCustomerRef, getCustomerRefs, type TimelineItem } from '../customers/index.js';
import { VisitModel } from './models/visit.model.js';

type Lean = Record<string, any> & { _id: { toHexString(): string } };
export const OUTCOMES = ['paid', 'partial_paid', 'promised', 'not_home', 'refused', 'shifted_address', 'customer_dead', 'product_returned_request', 'other'] as const;
const OUTCOME_BN: Record<string, string> = { paid: 'পরিশোধ', partial_paid: 'আংশিক পরিশোধ', promised: 'প্রতিশ্রুতি', not_home: 'বাড়িতে নেই', refused: 'অস্বীকার', shifted_address: 'ঠিকানা পরিবর্তন', customer_dead: 'মৃত', product_returned_request: 'পণ্য ফেরতের অনুরোধ', other: 'অন্যান্য' };

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
});

export function scopeFilter(user: AuthUser): Record<string, unknown> {
  if (isSuperAdmin(user)) return {};
  if (user.role === 'field_staff') return { userId: user.id };
  return { branchId: { $in: user.branchIds } };
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
  };
}

/** FR-VIS-001. Idempotent by clientId (offline retries); the visit never waits for its photos (FR-VIS-003). */
export async function create(user: AuthUser, input: z.infer<typeof createSchema>): Promise<{ statusCode: 200 | 201; body: ReturnType<typeof view> }> {
  const prior = (await VisitModel.findOne({ clientId: input.clientId }).lean()) as Lean | null;
  if (prior) {
    if (prior.userId !== user.id) throw new AppError('IDEMPOTENCY_MISMATCH', { clientId: input.clientId });
    return { statusCode: 200, body: view(prior) };
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
    });
    const lean = v.toObject() as Lean;
    await recordChange({ entity: 'visit', entityId: lean._id.toHexString(), userIds: [user.id], branchId: c.branchId });
    await ctx().bus.emit('visit.recorded', { visitId: lean._id.toHexString(), customerId: c.id, branchId: c.branchId, userId: user.id, outcome: input.outcome, flags });
    return { statusCode: 201, body: view(lean) };
  } catch (e) {
    if (isDuplicateKey(e)) return create(user, input);
    throw e;
  }
}

export async function checkout(user: AuthUser, id: string, input: { checkOutAt: string; outcome?: (typeof OUTCOMES)[number] | undefined }) {
  if (!isOid(id)) throw notFound('visit');
  const v = (await VisitModel.findOne({ _id: id, userId: user.id }).lean()) as Lean | null;
  if (!v) throw notFound('visit');
  const at = new Date(input.checkOutAt);
  if (at < v.checkInAt) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'checkOutAt', message: 'before check-in' }] });
  if (v.checkOutAt) return view(v); // idempotent
  await VisitModel.updateOne({ _id: id }, { $set: { checkOutAt: at, ...(input.outcome ? { outcome: input.outcome } : {}) } });
  await recordChange({ entity: 'visit', entityId: id, userIds: [user.id], branchId: v.branchId });
  return view((await VisitModel.findById(id).lean()) as Lean);
}

/** List rows carry display refs so admin tables need no extra calls (contract 1.4.0). */
async function withRefs(rows: Lean[]) {
  const refs = await getCustomerRefs(rows.map((r) => r.customerId));
  const users = await getUsers(rows.map((r) => r.userId));
  return rows.map((v) => {
    const ref = refs.get(v.customerId);
    const u = users.get(v.userId);
    return { ...view(v), customer: { id: v.customerId, name: ref?.name ?? { bn: '', en: '' }, code: ref?.code ?? '' }, user: { id: v.userId, name: u ? u.name.en || u.name.bn : '' } };
  });
}

export async function list(user: AuthUser, q: { branchId?: string | undefined; userId?: string | undefined; customerId?: string | undefined; date?: string | undefined; from?: string | undefined; to?: string | undefined; outcome?: string | undefined; limit: number; cursor?: string | undefined }) {
  const f: Record<string, unknown> = { ...scopeFilter(user), ...(q.branchId ? branchQuery(user, q.branchId) : {}) };
  if (q.userId && user.role !== 'field_staff') f.userId = q.userId;
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
  const v = (await VisitModel.findOne({ _id: id, ...scopeFilter(user) }).lean()) as Lean | null;
  if (!v) throw notFound('visit');
  return view(v);
}

export async function lastVisits(customerIds: string[]): Promise<Map<string, Date>> {
  const rows = await VisitModel.aggregate([{ $match: { customerId: { $in: customerIds } } }, { $group: { _id: '$customerId', at: { $max: '$checkInAt' } } }]);
  return new Map(rows.map((r: { _id: string; at: Date }) => [r._id, r.at]));
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
