import type { ClientSession } from 'mongoose';
import { z } from 'zod';
import { ctx } from '../../core/context/index.js';
import { AppError, businessRule, notFound } from '../../core/errors/index.js';
import { isOid, withTransaction, type LeanDoc } from '../../core/db/index.js';
import { branchQuery, canSeeBranch, type AuthUser } from '../../core/security/types.js';
import type { RequestMeta } from '../../core/http/router.js';
import * as audit from '../audit/index.js';
import { getUser, getUsers } from '../users/index.js';
import { applyAssignments, assignmentStateOfBranch, getCustomerRef, getCustomerRefs, idsInArea, type AssignmentChange, type TimelineItem } from '../customers/index.js';
import { computePrimary, type ActiveAssignment } from './domain/primary.js';
import { AreaModel, AssignmentModel } from './models/assignment.model.js';

type Lean = LeanDoc;

// ---------------- areas (FR-ASG-001) ----------------

const polygon = z.object({ type: z.literal('Polygon'), coordinates: z.array(z.array(z.tuple([z.number(), z.number()])).min(4)).min(1) });
export const areaSchema = z
  .object({
    branchId: z.string(),
    name: z.object({ bn: z.string().min(1).max(100), en: z.string().min(1).max(100) }),
    code: z.string().regex(/^[A-Z0-9-]{2,30}$/),
    kind: z.enum(['polygon', 'codes']),
    polygon: polygon.nullable().optional(),
    erpAreaCodes: z.array(z.string().max(50)).max(200).optional(),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    active: z.boolean().optional(),
  })
  .refine((a) => (a.kind === 'polygon' ? !!a.polygon : (a.erpAreaCodes?.length ?? 0) > 0), { message: 'polygon or erpAreaCodes required for kind', path: ['kind'] });
export const areaPatchSchema = z.object({
  name: z.object({ bn: z.string().min(1).max(100), en: z.string().min(1).max(100) }).optional(),
  polygon: polygon.nullable().optional(),
  erpAreaCodes: z.array(z.string().max(50)).max(200).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  active: z.boolean().optional(),
});

function areaView(a: Lean, counts: Map<string, number>, assignees: Map<string, string[]>) {
  return {
    id: a._id.toHexString(),
    branchId: a.branchId,
    name: a.name,
    code: a.code,
    kind: a.kind,
    ...(a.polygon ? { polygon: a.polygon } : {}),
    erpAreaCodes: a.erpAreaCodes ?? [],
    color: a.color,
    customerCount: counts.get(a._id.toHexString()) ?? 0,
    assignees: assignees.get(a._id.toHexString()) ?? [],
    active: a.active,
    version: a.version,
  };
}

export async function listAreas(user: AuthUser, branchId?: string) {
  const areas = (await AreaModel.find(branchQuery(user, branchId)).sort({ code: 1 }).lean()) as Lean[];
  const ids = areas.map((a) => a._id.toHexString());
  const active = await AssignmentModel.find({ type: 'area', areaId: { $in: ids }, effectiveTo: null }).lean();
  const assignees = new Map<string, string[]>();
  for (const a of active) assignees.set(a.areaId!, [...(assignees.get(a.areaId!) ?? []), a.userId]);
  const counts = new Map<string, number>();
  for (const b of new Set(areas.map((a) => a.branchId as string))) for (const c of await assignmentStateOfBranch(b)) if (c.areaId) counts.set(c.areaId, (counts.get(c.areaId) ?? 0) + 1);
  return areas.map((a) => areaView(a, counts, assignees));
}

export async function createArea(user: AuthUser, input: z.infer<typeof areaSchema>, meta: RequestMeta) {
  if (!canSeeBranch(user, input.branchId)) throw notFound('branch');
  if (await AreaModel.exists({ branchId: input.branchId, code: input.code })) throw new AppError('INVALID_STATE', { reason: 'AREA_CODE_TAKEN' });
  const a = await AreaModel.create({ ...input, createdBy: user.id });
  await audit.record({ actor: user, action: 'area.created', entity: 'area', entityId: a._id.toHexString(), branchId: input.branchId, after: input, meta });
  await recomputeBranch(input.branchId);
  return (await listAreas(user, input.branchId)).find((x) => x.id === a._id.toHexString())!;
}

export async function updateArea(user: AuthUser, id: string, input: z.infer<typeof areaPatchSchema>, ifMatch: number | null, meta: RequestMeta) {
  if (!isOid(id)) throw notFound('area');
  const a = (await AreaModel.findOne({ _id: id, ...branchQuery(user, undefined) }).lean()) as Lean | null;
  if (!a) throw notFound('area');
  if (ifMatch !== null && ifMatch !== a.version) throw new AppError('PRECONDITION_FAILED', { currentVersion: a.version });
  const r = await AreaModel.updateOne({ _id: id, version: a.version }, { $set: input, $inc: { version: 1 } });
  if (r.modifiedCount !== 1) throw new AppError('PRECONDITION_FAILED');
  await audit.record({ actor: user, action: 'area.updated', entity: 'area', entityId: id, branchId: a.branchId, before: { polygon: a.polygon, erpAreaCodes: a.erpAreaCodes, active: a.active }, after: input, meta });
  await recomputeBranch(a.branchId);
  return (await listAreas(user, a.branchId)).find((x) => x.id === id)!;
}

// ---------------- assignments (FR-ASG-002..004) ----------------

function assignmentView(a: Lean) {
  return {
    id: a._id.toHexString(),
    userId: a.userId,
    type: a.type,
    ...(a.areaId ? { areaId: a.areaId } : {}),
    ...(a.customerId ? { customerId: a.customerId } : {}),
    effectiveFrom: a.effectiveFrom.toISOString(),
    effectiveTo: a.effectiveTo ? a.effectiveTo.toISOString() : null,
    source: a.source,
  };
}

export async function listAssignments(user: AuthUser, q: { branchId?: string | undefined; userId?: string | undefined; customerId?: string | undefined; active: boolean }) {
  const filter: Record<string, unknown> = { ...branchQuery(user, q.branchId) };
  if (user.role === 'field_staff') filter.userId = user.id; // staff see only their own
  else if (q.userId) filter.userId = q.userId;
  if (q.customerId) filter.customerId = q.customerId;
  if (q.active) filter.effectiveTo = null;
  const rows = (await AssignmentModel.find(filter).sort({ effectiveFrom: -1 }).limit(2000).lean()) as Lean[];
  return rows.map(assignmentView);
}

async function assertStaff(actor: AuthUser, userId: string, branchId: string) {
  const u = isOid(userId) ? await getUser(userId) : null;
  if (!u || !canSeeBranch(actor, u.branchIds.find((b) => b === branchId) ?? null)) throw notFound('user');
  if (!u.active) throw businessRule('USER_INACTIVE');
  if (u.role !== 'field_staff') throw businessRule('NOT_FIELD_STAFF');
  if (!u.branchIds.includes(branchId)) throw businessRule('USER_NOT_IN_BRANCH');
  return u;
}

/** End active assignments for the same target (one primary per area / per customer). */
async function endTargets(filter: Record<string, unknown>, by: string, session?: ClientSession): Promise<string[]> {
  const now = ctx().clock.now();
  const rows = await AssignmentModel.find({ ...filter, effectiveTo: null }).select('_id').session(session ?? null).lean();
  if (!rows.length) return [];
  await AssignmentModel.updateMany({ _id: { $in: rows.map((r) => r._id) } }, { $set: { effectiveTo: now, endedBy: by } }, { session });
  return rows.map((r) => r._id.toHexString());
}

export async function createAssignment(user: AuthUser, input: { userId: string; type: 'area' | 'customer'; areaId?: string | undefined; customerId?: string | undefined; reason?: string | undefined }, meta: RequestMeta) {
  let branchId: string;
  if (input.type === 'area') {
    if (!input.areaId || !isOid(input.areaId)) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'areaId', message: 'required for type=area' }] });
    const area = await AreaModel.findOne({ _id: input.areaId, ...branchQuery(user, undefined) }).lean();
    if (!area) throw notFound('area');
    if (!area.active) throw businessRule('AREA_INACTIVE');
    branchId = area.branchId;
  } else {
    if (!input.customerId) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'customerId', message: 'required for type=customer' }] });
    const c = await getCustomerRef(user, input.customerId);
    if (!c?.branchId) throw notFound('customer');
    branchId = c.branchId;
  }
  await assertStaff(user, input.userId, branchId);
  const now = ctx().clock.now();
  const created = await withTransaction(async (session) => {
    const ended = await endTargets(input.type === 'area' ? { type: 'area', areaId: input.areaId } : { type: 'customer', customerId: input.customerId }, user.id, session);
    const [a] = await AssignmentModel.create(
      [{ branchId, userId: input.userId, type: input.type, areaId: input.areaId ?? null, customerId: input.customerId ?? null, effectiveFrom: now, source: 'manual', reason: input.reason ?? null, createdBy: user.id }],
      { session },
    );
    await audit.record({ actor: user, action: 'assignment.created', entity: 'assignment', entityId: a!._id.toHexString(), branchId, after: { ...input, ended }, reason: input.reason ?? null, meta }, session);
    return a!;
  });
  await recomputeBranch(branchId);
  return assignmentView(created.toObject() as Lean);
}

export async function bulkAssign(user: AuthUser, input: { userId: string; customerIds: string[]; reason?: string | undefined }, meta: RequestMeta) {
  const refs = await getCustomerRefs(input.customerIds);
  const valid = input.customerIds.filter((id) => {
    const r = refs.get(id);
    return r?.branchId && canSeeBranch(user, r.branchId);
  });
  const byBranch = new Map<string, string[]>();
  for (const id of new Set(valid)) {
    const b = refs.get(id)!.branchId!;
    byBranch.set(b, [...(byBranch.get(b) ?? []), id]);
  }
  let assigned = 0;
  for (const [branchId, ids] of byBranch) {
    try {
      await assertStaff(user, input.userId, branchId);
    } catch {
      continue; // customers in a branch the staff is not in are skipped
    }
    const now = ctx().clock.now();
    await withTransaction(async (session) => {
      await endTargets({ type: 'customer', customerId: { $in: ids } }, user.id, session);
      await AssignmentModel.insertMany(
        ids.map((customerId) => ({ branchId, userId: input.userId, type: 'customer', customerId, effectiveFrom: now, source: 'bulk', reason: input.reason ?? null, createdBy: user.id })),
        { session },
      );
      await audit.record({ actor: user, action: 'assignment.bulk', entity: 'assignment', entityId: input.userId, branchId, after: { userId: input.userId, customerIds: ids }, reason: input.reason ?? null, meta }, session);
    });
    assigned += ids.length;
    await recomputeBranch(branchId);
  }
  return { assigned, skipped: input.customerIds.length - assigned };
}

export async function endAssignment(user: AuthUser, id: string, meta: RequestMeta): Promise<void> {
  if (!isOid(id)) throw notFound('assignment');
  const a = await AssignmentModel.findOne({ _id: id, ...branchQuery(user, undefined) }).lean();
  if (!a) throw notFound('assignment');
  if (a.effectiveTo) throw new AppError('INVALID_STATE', { reason: 'ALREADY_ENDED' });
  await AssignmentModel.updateOne({ _id: id }, { $set: { effectiveTo: ctx().clock.now(), endedBy: user.id } });
  await audit.record({ actor: user, action: 'assignment.ended', entity: 'assignment', entityId: id, branchId: a.branchId, before: assignmentView(a as Lean), meta });
  await recomputeBranch(a.branchId);
}

// ---------------- recompute primary assignee → customers overlay ----------------

/** Recompute primary assignee for customers in a branch (all, or only `only`) and push only the differences. */
export async function recomputeBranch(branchId: string, only?: string[]): Promise<number> {
  const subset = only ? new Set(only) : null;
  const customers = (await assignmentStateOfBranch(branchId)).filter((c) => !subset || subset.has(c.id));
  if (!customers.length) return 0;
  const areas = await AreaModel.find({ branchId, active: true }).sort({ code: 1 }).lean();
  const areaOf = new Map<string, string>();
  for (const a of areas) {
    const ids = await idsInArea(branchId, { areaCodes: a.kind === 'codes' ? a.erpAreaCodes : [], polygon: a.kind === 'polygon' ? (a.polygon as Record<string, unknown>) : null });
    for (const id of ids) if (!areaOf.has(id)) areaOf.set(id, a._id.toHexString());
  }
  const active = (await AssignmentModel.find({ branchId, effectiveTo: null }).lean()).map(
    (a): ActiveAssignment => ({ id: a._id.toHexString(), userId: a.userId, type: a.type as 'area' | 'customer', areaId: a.areaId, customerId: a.customerId, effectiveFrom: a.effectiveFrom }),
  );
  const primary = computePrimary(customers.map((c) => c.id), areaOf, active);
  const changes: AssignmentChange[] = [];
  for (const c of customers) {
    const p = primary.get(c.id)!;
    if (p.assigneeId !== c.assigneeId || p.areaId !== c.areaId) changes.push({ customerId: c.id, assigneeId: p.assigneeId, areaId: p.areaId });
  }
  if (changes.length) {
    await applyAssignments(changes);
    await ctx().bus.emit('assignment.changed', { branchId, changes });
  }
  return changes.length;
}

// ---------------- used by handovers ----------------

export interface TransferResult {
  ended: string[];
  created: string[];
}

/**
 * Move areas/customers from one staff to another (handover acceptance). Runs inside the caller's transaction;
 * the caller must call recomputeBranch(branchId) after commit.
 */
export async function transfer(p: { branchId: string; fromUserId: string; toUserId: string; areaIds: string[]; customerIds: string[]; source: string; by: string }, session: ClientSession): Promise<TransferResult> {
  const now = ctx().clock.now();
  const ended: string[] = [];
  const docs: Record<string, unknown>[] = [];
  for (const areaId of p.areaIds) {
    ended.push(...(await endTargets({ type: 'area', areaId, userId: p.fromUserId }, p.by, session)));
    docs.push({ branchId: p.branchId, userId: p.toUserId, type: 'area', areaId, effectiveFrom: now, source: p.source, createdBy: p.by });
  }
  for (const customerId of p.customerIds) {
    // Direct assignment of from-user ends; a customer held via an area gets a direct override for the receiver.
    ended.push(...(await endTargets({ type: 'customer', customerId, userId: p.fromUserId }, p.by, session)));
    docs.push({ branchId: p.branchId, userId: p.toUserId, type: 'customer', customerId, effectiveFrom: now, source: p.source, createdBy: p.by });
  }
  const created = docs.length ? await AssignmentModel.insertMany(docs, { session }) : [];
  return { ended, created: created.map((d) => d._id.toHexString()) };
}

/** Temporary cover end (FR-HO-006): end what the transfer created and restore what it ended. */
export async function revertTransfer(p: { branchId: string; source: string; ended: string[]; by: string }, session: ClientSession): Promise<void> {
  const now = ctx().clock.now();
  await AssignmentModel.updateMany({ source: p.source, effectiveTo: null }, { $set: { effectiveTo: now, endedBy: p.by } }, { session });
  const old = await AssignmentModel.find({ _id: { $in: p.ended } }).session(session).lean();
  const restore = [];
  for (const a of old) {
    // Do not restore over a newer manual decision for the same target.
    const target = a.type === 'area' ? { type: 'area', areaId: a.areaId } : { type: 'customer', customerId: a.customerId };
    if (await AssignmentModel.exists({ ...target, effectiveTo: null }).session(session)) continue;
    restore.push({ branchId: a.branchId, userId: a.userId, type: a.type, areaId: a.areaId, customerId: a.customerId, effectiveFrom: now, source: `revert:${p.source}`, createdBy: p.by });
  }
  if (restore.length) await AssignmentModel.insertMany(restore, { session });
}

/** Areas held by a user (direct area assignments). */
export async function areasHeldBy(userId: string): Promise<string[]> {
  return (await AssignmentModel.find({ userId, type: 'area', effectiveTo: null }).select('areaId').lean()).map((a) => a.areaId!).filter(Boolean);
}

/** customerId → area name, for the customer list (contract 1.2.0 `areaName`). */
export async function areaNamesFor(customerIds: string[]): Promise<Map<string, { bn: string; en: string }>> {
  const refs = await getCustomerRefs(customerIds);
  const areaIds = [...new Set([...refs.values()].map((r) => r.areaId).filter((x): x is string => !!x && isOid(x)))];
  if (!areaIds.length) return new Map();
  const areas = await AreaModel.find({ _id: { $in: areaIds } }).select('name').lean();
  const names = new Map(areas.map((a) => [a._id.toHexString(), { bn: a.name?.bn ?? '', en: a.name?.en ?? '' }]));
  const out = new Map<string, { bn: string; en: string }>();
  for (const [id, r] of refs) if (r.areaId && names.has(r.areaId)) out.set(id, names.get(r.areaId)!);
  return out;
}

/**
 * FR-ASG-004 on the customer timeline: direct assignments of this customer, when they started and ended.
 * Area assignments are not listed per customer (they belong to the area's history).
 */
export async function customerTimeline(customerId: string, _user: AuthUser, before: Date | null, limit: number): Promise<TimelineItem[]> {
  const rows = await AssignmentModel.find({ type: 'customer', customerId }).sort({ effectiveFrom: -1 }).limit(limit * 2).lean();
  const people = await getUsers([...new Set(rows.flatMap((r) => [r.userId, r.createdBy ?? '', r.endedBy ?? ''].filter(Boolean)))]);
  const name = (id: string | null | undefined) => {
    const u = id ? people.get(id) : undefined;
    return u ? u.name.en || u.name.bn : '';
  };
  const items: TimelineItem[] = [];
  for (const r of rows) {
    const who = name(r.userId);
    const actorOf = (id: string | null | undefined) => (id && people.get(id) ? { actor: { id, name: name(id) } } : {});
    if (r.effectiveTo && (!before || r.effectiveTo < before))
      items.push({
        kind: 'assignment',
        at: r.effectiveTo.toISOString(),
        ...actorOf(r.endedBy),
        summary: { en: `Assignment to ${who} ended`, bn: `${who}-এর দায়িত্ব শেষ` },
        refId: r._id.toHexString(),
        data: { userId: r.userId, source: r.source, event: 'ended' },
      });
    // newest first: an end is listed before its start when both carry the same time
    if (!before || r.effectiveFrom < before)
      items.push({
        kind: 'assignment',
        at: r.effectiveFrom.toISOString(),
        ...actorOf(r.createdBy),
        summary: { en: `Assigned to ${who}`, bn: `${who}-কে দায়িত্ব দেওয়া হয়েছে` },
        refId: r._id.toHexString(),
        data: { userId: r.userId, source: r.source, event: 'started' },
      });
  }
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
