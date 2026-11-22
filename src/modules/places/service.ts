import { z } from 'zod';
import type { ClientSession } from 'mongoose';
import { ctx } from '../../core/context/index.js';
import { AppError, businessRule, invalidState, notFound } from '../../core/errors/index.js';
import { isDuplicateKey, isOid, withTransaction, type LeanDoc } from '../../core/db/index.js';
import { recordChanges } from '../../core/changefeed/index.js';
import { decodeCursor, encodeCursor } from '../../core/http/index.js';
import type { RequestMeta } from '../../core/http/router.js';
import { haversineM, parseBbox, type LatLng } from '../../core/geo/index.js';
import type { AuthUser } from '../../core/security/types.js';
import * as audit from '../audit/index.js';
import { can } from '../rbac/index.js';
import { getUsers } from '../users/index.js';
import { listBranches } from '../branches/index.js';
import { canEdit, checkDecision, checkMoveRequest, containsPattern, NAME_MAX, NOTE_MAX, PLACE_ICONS, recentEvents, validPoint, type PendingMove, type PlaceState } from './domain/rules.js';
import { PlaceModel } from './models/place.model.js';

type Lean = LeanDoc;
const now = () => ctx().clock.now();
const iso = (d: unknown) => (d ? (d as Date).toISOString() : null);
const idOf = (p: Lean): string => p._id.toHexString();
const MANAGE = 'place.manage';

// ---------------- input (zod; the same schemas serve REST and /sync/push) ----------------

const latLng = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const name = z.string().trim().min(1).max(NAME_MAX);
const icon = z.enum(PLACE_ICONS);
const note = z.string().trim().max(NOTE_MAX);

export const createSchema = z.object({
  clientId: z.string().uuid(),
  name,
  icon,
  note: note.optional(),
  location: latLng,
  /** Accepted for older clients and ignored (1.42.0, ADR-054): a place belongs to no branch. */
  branchId: z.string().max(64).optional(),
});
export const editSchema = z
  .object({ name: name.optional(), icon: icon.optional(), note: note.nullable().optional(), location: latLng.optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to change' });
export const moveRequestSchema = z.object({ clientId: z.string().uuid(), location: latLng, reason: z.string().trim().max(NOTE_MAX).optional() });
export const decisionSchema = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(500).optional() });
export const listQuery = z.object({
  branchId: z.string().max(64).optional(),
  q: z.string().trim().max(NAME_MAX).optional(),
  icon: icon.optional(),
  bbox: z.string().max(100).optional(),
  pendingMove: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  status: z.enum(['active', 'deleted']).default('active'),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  cursor: z.string().max(200).optional(),
});
/** A sync mutation names the place by server id, or by its own clientId when the create has not been synced yet. */
export const placeRef = z.object({ placeId: z.string().max(64).optional(), placeClientId: z.string().uuid().optional() }).refine((v) => !!v.placeId !== !!v.placeClientId, { message: 'placeId or placeClientId' });

// ---------------- representation ----------------

const loc = (p: Lean): LatLng => ({ lat: (p.point.coordinates as number[])[1]!, lng: (p.point.coordinates as number[])[0]! });
const state = (p: Lean): PlaceState => ({ status: p.status, createdBy: p.createdBy, location: loc(p), pendingMove: (p.pendingMove as PendingMove | null) ?? null });

async function views(rows: Lean[]) {
  const ids = rows.flatMap((p) => [
    p.createdBy as string,
    p.updatedBy as string,
    ...(p.pendingMove ? [p.pendingMove.requestedBy as string] : []),
    ...(p.lastMoveDecision ? [p.lastMoveDecision.by as string, p.lastMoveDecision.requestedBy as string] : []),
    ...((p.events ?? []) as { by: string }[]).map((e) => e.by),
  ]);
  const people = await getUsers([...new Set(ids)]);
  const who = (id: string) => ({ id, name: people.get(id)?.name.en || people.get(id)?.name.bn || '' });
  return rows.map((p) => {
    const at = loc(p);
    const pm = p.pendingMove as PendingMove | null;
    const d = p.lastMoveDecision as { decision: 'approve' | 'reject'; by: string; at: Date; reason: string | null; requestedBy: string } | null;
    return {
      id: idOf(p),
      clientId: (p.clientId as string | null) ?? null,
      // Informational only (1.42.0, ADR-054): the adder's first branch, '' when they have none (stays a string in /api/v1).
      branchId: (p.branchId as string | null) ?? '',
      name: p.name as string,
      icon: p.icon as string,
      note: (p.note as string | null) ?? null,
      location: at,
      status: p.status as 'active' | 'deleted',
      version: p.version as number,
      pendingMove: pm
        ? { location: { lat: pm.lat, lng: pm.lng }, requestedBy: who(pm.requestedBy), requestedAt: iso(pm.requestedAt)!, reason: pm.reason ?? null, distanceM: Math.round(haversineM(at, pm)) }
        : null,
      lastMoveDecision: d ? { decision: d.decision, by: who(d.by), at: iso(d.at)!, reason: d.reason ?? null, requestedBy: who(d.requestedBy) } : null,
      createdBy: who(p.createdBy),
      updatedBy: who(p.updatedBy),
      createdAt: iso(p.createdAt)!,
      updatedAt: iso(p.updatedAt)!,
      deletedAt: iso(p.deletedAt),
      deleteReason: (p.deleteReason as string | null) ?? null,
      events: recentEvents((p.events ?? []) as { type: string; by: string; at: Date; note: string | null; from: LatLng | null; to: LatLng | null }[]).map((e) => ({
        type: e.type,
        by: who(e.by),
        at: iso(e.at)!,
        note: e.note ?? null,
        from: e.from ? { lat: e.from.lat, lng: e.from.lng } : null,
        to: e.to ? { lat: e.to.lat, lng: e.to.lng } : null,
      })),
    };
  });
}
const view = async (p: Lean) => (await views([p]))[0]!;
export type PlaceView = Awaited<ReturnType<typeof view>>;

/**
 * Places are shared landmarks for the whole area (ADR-054): every device of every branch learns about every change on
 * its next pull (sync entity `place`). The feed fans out per branch, so one entry per branch.
 */
async function changed(p: Lean, actorId: string, session: ClientSession, op: 'upsert' | 'delete' = 'upsert') {
  const base = { entity: 'place', entityId: idOf(p), op, ...(op === 'delete' ? { reason: 'deleted' } : {}), userIds: [actorId], branchId: (p.branchId as string | null) ?? null };
  const branches = await listBranches();
  await recordChanges(branches.length ? branches.map((b) => ({ ...base, fanoutBranchId: b.id })) : [base], session);
}
const eventOf = (type: string, by: string, at: Date, extra: { note?: string | null; from?: LatLng | null; to?: LatLng | null; clientId?: string } = {}) => ({
  type,
  by,
  at,
  note: extra.note ?? null,
  from: extra.from ?? null,
  to: extra.to ?? null,
  clientId: extra.clientId ?? null,
});
const point = (p: LatLng) => ({ type: 'Point' as const, coordinates: [p.lng, p.lat] });
const auditView = (p: Lean) => ({ name: p.name, icon: p.icon, note: p.note ?? null, location: loc(p), status: p.status });

/**
 * No branch scope (ADR-054): a place is a shared landmark, not customer-linked data, so CLAUDE.md §2.7 does not apply and
 * everyone with `place.view` sees every place. A deleted place is 404 for staff.
 */
async function load(id: string, opts: { deleted?: boolean } = {}): Promise<Lean> {
  if (!isOid(id)) throw notFound('place');
  const p = (await PlaceModel.findOne({ _id: id }).lean()) as Lean | null;
  if (!p || (p.status === 'deleted' && !opts.deleted)) throw notFound('place');
  return p;
}

/** Writes on the version the caller read; losing a race to another change is INVALID_STATE PLACE_CHANGED (read again). */
async function write(p: Lean, actor: AuthUser, update: { $set: Record<string, unknown>; event: ReturnType<typeof eventOf> }, auditEntry: { action: string; reason?: string | null; meta: RequestMeta }, op: 'upsert' | 'delete' = 'upsert') {
  const at = now();
  const next = await withTransaction(async (session) => {
    const doc = (await PlaceModel.findOneAndUpdate(
      { _id: p._id, version: p.version },
      { $set: { ...update.$set, updatedBy: actor.id, updatedAt: at }, $inc: { version: 1 }, $push: { events: update.event } },
      { new: true, session },
    ).lean()) as Lean | null;
    if (!doc) return null;
    await changed(doc, actor.id, session, op);
    await audit.record({ actor, action: auditEntry.action, entity: 'place', entityId: idOf(doc), branchId: doc.branchId, before: auditView(p), after: auditView(doc), reason: auditEntry.reason ?? null, meta: auditEntry.meta }, session);
    return doc;
  });
  if (!next) throw invalidState('PLACE_CHANGED');
  return next;
}

// ---------------- create / read ----------------

/** FR-PLC-002: visible to everyone at once. Needs no branch (ADR-054). Idempotent by (createdBy, clientId). */
export async function create(user: AuthUser, input: z.infer<typeof createSchema>, meta: RequestMeta): Promise<{ statusCode: 200 | 201; body: PlaceView }> {
  const prior = (await PlaceModel.findOne({ createdBy: user.id, clientId: input.clientId }).lean()) as Lean | null;
  if (prior) return { statusCode: 200, body: await view(prior) };
  if (!validPoint(input.location)) throw businessRule('OUTSIDE_BANGLADESH');
  // The client's branchId is ignored; the creator's first branch is kept for the record and the audit only.
  const branchId = user.branchIds[0] ?? null;
  const at = now();
  let doc: Lean;
  try {
    doc = await withTransaction(async (session) => {
      const [created] = await PlaceModel.create(
        [
          {
            clientId: input.clientId,
            branchId,
            name: input.name,
            note: input.note || null,
            icon: input.icon,
            point: point(input.location),
            events: [eventOf('created', user.id, at, { to: input.location })],
            createdBy: user.id,
            updatedBy: user.id,
            createdAt: at,
            updatedAt: at,
          },
        ],
        { session },
      );
      const p = created!.toObject() as Lean;
      await changed(p, user.id, session);
      await audit.record({ actor: user, action: 'place.created', entity: 'place', entityId: idOf(p), branchId, after: auditView(p), meta }, session);
      return p;
    });
  } catch (err) {
    // Two sends of the same offline row race to the unique (createdBy, clientId) index: the loser answers with the winner.
    const winner = isDuplicateKey(err) ? ((await PlaceModel.findOne({ createdBy: user.id, clientId: input.clientId }).lean()) as Lean | null) : null;
    if (!winner) throw err;
    return { statusCode: 200, body: await view(winner) };
  }
  await ctx().bus.emit('place.created', { placeId: idOf(doc), branchId, createdBy: user.id });
  return { statusCode: 201, body: await view(doc) };
}

export async function list(user: AuthUser, q: z.infer<typeof listQuery>) {
  if (q.status === 'deleted' && !(await can(user, MANAGE))) throw new AppError('FORBIDDEN', { permission: MANAGE });
  // ?branchId= narrows to places added from that branch; it is a filter, not a scope (ADR-054).
  const f: Record<string, unknown> = { status: q.status, ...(q.branchId ? { branchId: q.branchId } : {}) };
  if (q.icon) f.icon = q.icon;
  if (q.pendingMove !== undefined) f.pendingMove = q.pendingMove ? { $ne: null } : null;
  if (q.q) {
    const rx = { $regex: containsPattern(q.q), $options: 'i' };
    f.$or = [{ name: rx }, { note: rx }];
  }
  if (q.bbox) {
    const b = parseBbox(q.bbox);
    if (!b) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'bbox', message: 'expected minLng,minLat,maxLng,maxLat' }] });
    f.point = { $geoWithin: { $box: [[b.minLng, b.minLat], [b.maxLng, b.maxLat]] } };
  }
  const cur = decodeCursor<{ id: string }>(q.cursor);
  if (cur && isOid(cur.id)) f._id = { $lt: cur.id };
  const rows = (await PlaceModel.find(f).sort({ _id: -1 }).limit(q.limit + 1).lean()) as Lean[];
  const items = rows.slice(0, q.limit);
  return { items: await views(items), nextCursor: rows.length > q.limit ? encodeCursor({ id: idOf(items[items.length - 1]!) }) : null };
}

export async function get(user: AuthUser, id: string) {
  return view(await load(id, { deleted: await can(user, MANAGE) }));
}

// ---------------- edit / delete ----------------

/** FR-PLC-003: the creator changes the words and icon; the office changes anything, including a direct move. */
export async function edit(user: AuthUser, id: string, input: z.infer<typeof editSchema>, ifMatch: number | null, meta: RequestMeta) {
  const manage = await can(user, MANAGE);
  const p = await load(id, { deleted: manage });
  const rule = canEdit(state(p), user.id, manage, !!input.location);
  if (!rule.ok) throw new AppError('FORBIDDEN', { permission: MANAGE, reason: rule.code });
  if (p.status === 'deleted') throw invalidState('PLACE_DELETED');
  if (ifMatch !== null && ifMatch !== p.version) throw new AppError('PRECONDITION_FAILED', { currentVersion: p.version });
  if (input.location && !validPoint(input.location)) throw businessRule('OUTSIDE_BANGLADESH');

  const set: Record<string, unknown> = {};
  if (input.name !== undefined && input.name !== p.name) set.name = input.name;
  if (input.icon !== undefined && input.icon !== p.icon) set.icon = input.icon;
  if (input.note !== undefined && (input.note || null) !== (p.note ?? null)) set.note = input.note || null;
  const from = loc(p);
  const moves = !!input.location && haversineM(from, input.location) > 0;
  if (moves) set.point = point(input.location!);
  // Nothing new (an offline retry, or the same values typed again): no version bump, no audit line.
  if (!Object.keys(set).length) return view(p);

  const pending = (p.pendingMove as PendingMove | null) ?? null;
  // A direct move answers an open request: it is closed as rejected, so the requester is told what happened.
  const closes = moves && pending;
  if (closes) {
    set.pendingMove = null;
    set.lastMoveDecision = { decision: 'reject', by: user.id, at: now(), reason: 'Moved by the office', requestedBy: pending.requestedBy };
  }
  const next = await write(p, user, { $set: set, event: moves ? eventOf('moved', user.id, now(), { from, to: input.location! }) : eventOf('edited', user.id, now()) }, { action: moves ? 'place.moved' : 'place.edited', meta });
  if (moves) await ctx().bus.emit('place.moved', { placeId: id, branchId: next.branchId, by: user.id });
  else await ctx().bus.emit('place.updated', { placeId: id, branchId: next.branchId, by: user.id });
  if (closes) await ctx().bus.emit('place.move_decided', { placeId: id, branchId: next.branchId, name: next.name, decision: 'reject', requestedBy: pending.requestedBy, decidedBy: user.id, reason: 'Moved by the office', requestClientId: pending.clientId });
  return view(next);
}

/** FR-PLC-006: soft delete; the row and its history stay. Idempotent. */
export async function remove(user: AuthUser, id: string, reason: string | undefined, meta: RequestMeta) {
  const p = await load(id, { deleted: true });
  if (p.status === 'deleted') return view(p);
  const at = now();
  const pending = (p.pendingMove as PendingMove | null) ?? null;
  const why = reason?.trim() || null;
  const next = await write(
    p,
    user,
    { $set: { status: 'deleted', deletedAt: at, deletedBy: user.id, deleteReason: why, pendingMove: null }, event: eventOf('deleted', user.id, at, { note: why }) },
    { action: 'place.deleted', reason: why, meta },
    'delete',
  );
  await ctx().bus.emit('place.deleted', { placeId: id, branchId: next.branchId, by: user.id });
  // The open request has nothing left to decide: the inbox item closes and the requester is told.
  if (pending) await ctx().bus.emit('place.move_decided', { placeId: id, branchId: next.branchId, name: next.name, decision: 'reject', requestedBy: pending.requestedBy, decidedBy: user.id, reason: 'Place removed', requestClientId: pending.clientId });
  return view(next);
}

// ---------------- move requests (FR-PLC-004/005) ----------------

/** Staff ask the office to move a marker; it stays where it is until approved. Idempotent by clientId. */
export async function requestMove(user: AuthUser, id: string, input: z.infer<typeof moveRequestSchema>, meta: RequestMeta): Promise<{ statusCode: 200 | 201; body: PlaceView }> {
  // A deleted place is 404 to staff (it is gone from their map); the office sees why (PLACE_DELETED).
  const p = await load(id, { deleted: await can(user, MANAGE) });
  // An offline retry of a request the office already decided is a replay too, not a second request.
  if ((p.events as { type: string; by: string; clientId?: string | null }[]).some((e) => e.type === 'move_requested' && e.by === user.id && e.clientId === input.clientId))
    return { statusCode: 200, body: await view(p) };
  const check = checkMoveRequest(state(p), user.id, input.clientId, input.location);
  if (check.kind === 'replay') return { statusCode: 200, body: await view(p) };
  if (check.kind === 'error') throw check.code === 'OUTSIDE_BANGLADESH' || check.code === 'MOVE_TOO_SHORT' ? businessRule(check.code) : invalidState(check.code);
  const at = now();
  const reason = input.reason || null;
  const next = await write(
    p,
    user,
    {
      $set: { pendingMove: { lat: input.location.lat, lng: input.location.lng, requestedBy: user.id, requestedAt: at, reason, clientId: input.clientId } },
      event: eventOf('move_requested', user.id, at, { note: reason, from: loc(p), to: input.location, clientId: input.clientId }),
    },
    { action: 'place.move_requested', reason, meta },
  );
  await ctx().bus.emit('place.move_requested', { placeId: id, branchId: next.branchId, name: next.name, requestedBy: user.id, requestedByName: user.name.en || user.name.bn || '', distanceM: check.distanceM, requestClientId: input.clientId });
  return { statusCode: 201, body: await view(next) };
}

/** The office queue: every open request (any branch, ADR-054), oldest first. */
export async function moveRequests(branchId?: string) {
  const rows = (await PlaceModel.find({ ...(branchId ? { branchId } : {}), status: 'active', pendingMove: { $ne: null } }).sort({ 'pendingMove.requestedAt': 1 }).limit(500).lean()) as Lean[];
  return { items: await views(rows) };
}

export async function decideMove(user: AuthUser, id: string, input: z.infer<typeof decisionSchema>, meta: RequestMeta) {
  const p = await load(id, { deleted: true });
  const rule = checkDecision(state(p), input.decision, input.reason);
  if (!rule.ok) throw rule.code === 'REASON_REQUIRED' ? businessRule(rule.code) : invalidState(rule.code);
  const pending = p.pendingMove as PendingMove;
  const at = now();
  const reason = input.reason || null;
  const approve = input.decision === 'approve';
  const to = { lat: pending.lat, lng: pending.lng };
  const next = await write(
    p,
    user,
    {
      $set: { pendingMove: null, lastMoveDecision: { decision: input.decision, by: user.id, at, reason, requestedBy: pending.requestedBy }, ...(approve ? { point: point(to) } : {}) },
      event: eventOf(approve ? 'move_approved' : 'move_rejected', user.id, at, { note: reason, from: loc(p), to }),
    },
    { action: approve ? 'place.move_approved' : 'place.move_rejected', reason, meta },
  );
  await ctx().bus.emit('place.move_decided', { placeId: id, branchId: next.branchId, name: next.name, decision: input.decision, requestedBy: pending.requestedBy, decidedBy: user.id, reason, requestClientId: pending.clientId });
  if (approve) await ctx().bus.emit('place.moved', { placeId: id, branchId: next.branchId, by: user.id });
  return view(next);
}

// ---------------- sync ----------------

/** A place named by its server id, or by the clientId of a place this user created offline (edits before the create synced). */
export async function resolveRef(user: AuthUser, ref: z.infer<typeof placeRef>): Promise<string> {
  if (ref.placeId) return ref.placeId;
  const p = (await PlaceModel.findOne({ createdBy: user.id, clientId: ref.placeClientId }).select({ _id: 1 }).lean()) as Lean | null;
  if (!p) throw notFound('place');
  return idOf(p);
}

/** Loader: active places (all branches, ADR-054); a deleted one becomes a tombstone on the device. */
export async function syncLoad(ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  const rows = (await PlaceModel.find({ _id: { $in: ids.filter(isOid) }, status: 'active' }).lean()) as Lean[];
  return new Map((await views(rows)).map((v) => [v.id, v]));
}

/** Bootstrap: every active place of every branch (ADR-054), paged by id. */
export async function snapshot(_user: AuthUser, cursor: string | null, limit: number) {
  const cur = decodeCursor<{ id: string }>(cursor ?? undefined);
  const rows = (await PlaceModel.find({ status: 'active', ...(cur && isOid(cur.id) ? { _id: { $gt: cur.id } } : {}) }).sort({ _id: 1 }).limit(limit + 1).lean()) as Lean[];
  const page = rows.slice(0, limit);
  return { items: await views(page), nextCursor: rows.length > limit ? encodeCursor({ id: idOf(page[page.length - 1]!) }) : null };
}
