import { z } from 'zod';
import { ctx } from '../../core/context/index.js';
import { businessRule, invalidState, notFound } from '../../core/errors/index.js';
import { isDuplicateKey, isOid, withTransaction, type LeanDoc } from '../../core/db/index.js';
import { recordChange } from '../../core/changefeed/index.js';
import { decodeCursor, encodeCursor } from '../../core/http/index.js';
import type { RequestMeta } from '../../core/http/router.js';
import { addDays, businessDate, isIsoDate, startOfBusinessDay } from '../../core/time/index.js';
import { branchQuery, canSeeBranch, type AuthUser } from '../../core/security/types.js';
import * as audit from '../audit/index.js';
import { getUser, getUsers } from '../users/index.js';
import { isOverdue, TASK_STATUSES, transition, type TaskStatus } from './domain/task.js';
import { TaskModel } from './models/task.model.js';

type Lean = LeanDoc;
const now = () => ctx().clock.now();
const iso = (d: unknown) => (d ? (d as Date).toISOString() : null);
const idOf = (t: Lean): string => t._id.toHexString();
const dueDate = z.string().refine(isIsoDate, 'YYYY-MM-DD');
const text = (max: number) => z.string().trim().min(1).max(max);

export const createSchema = z.object({
  clientId: z.string().uuid().optional(),
  assigneeId: z.string().min(1).max(64),
  /** Which of the assignee's branches the task belongs to. Default: the first one the caller can see. */
  branchId: z.string().max(64).optional(),
  title: text(120),
  note: text(2000).optional(),
  dueDate: dueDate.optional(),
});
export const editSchema = z
  .object({ title: text(120).optional(), note: z.string().trim().max(2000).nullable().optional(), dueDate: dueDate.nullable().optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to change' });
export const noteSchema = z.object({ note: z.string().trim().max(1000).optional() });
export const rejectSchema = z.object({ reason: z.string().trim().max(500).optional() });
export const resolveRequestSchema = z.object({ note: z.string().trim().max(1000).optional(), requestedAt: z.string().datetime({ offset: true }).optional() });
export const listQuery = z.object({
  status: z.enum(['open', 'resolve_requested', 'resolved', 'cancelled']).optional(),
  assigneeId: z.string().max(64).optional(),
  branchId: z.string().max(64).optional(),
  overdue: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

async function views(rows: Lean[]) {
  const people = await getUsers([...new Set(rows.flatMap((t) => [t.assigneeId as string, t.createdBy as string, ...(t.decidedBy ? [t.decidedBy as string] : []), ...((t.events ?? []) as { by: string }[]).map((e) => e.by)]))]);
  const who = (id: string) => ({ id, name: people.get(id)?.name.en || people.get(id)?.name.bn || '' });
  const today = businessDate(now());
  return rows.map((t) => ({
    id: idOf(t),
    branchId: t.branchId as string,
    assignee: { ...who(t.assigneeId), employeeCode: people.get(t.assigneeId)?.employeeCode ?? '' },
    createdBy: who(t.createdBy),
    title: t.title as string,
    note: (t.note as string | null) ?? null,
    dueDate: (t.dueDate as string | null) ?? null,
    status: t.status as TaskStatus,
    overdue: isOverdue(t.status, t.dueDate ?? null, today),
    resolveNote: (t.resolveNote as string | null) ?? null,
    resolveRequestedAt: iso(t.resolveRequestedAt),
    decisionNote: (t.decisionNote as string | null) ?? null,
    decidedBy: t.decidedBy ? who(t.decidedBy) : null,
    decidedAt: iso(t.decidedAt),
    events: ((t.events ?? []) as { type: string; by: string; at: Date; note: string | null }[]).map((e) => ({ type: e.type, by: who(e.by), at: iso(e.at)!, note: e.note ?? null })),
    createdAt: iso(t.createdAt)!,
    updatedAt: iso(t.updatedAt)!,
  }));
}
const view = async (t: Lean) => (await views([t]))[0]!;
export type TaskView = Awaited<ReturnType<typeof view>>;

/** The assignee learns about every change on the next pull (sync entity `task`). */
const changed = (t: Lean, session?: Parameters<typeof recordChange>[1]) => recordChange({ entity: 'task', entityId: idOf(t), userIds: [t.assigneeId], branchId: t.branchId }, session);
const eventOf = (type: string, by: string, at: Date, note: string | null) => ({ type, by, at, note });
const ACTIVE: TaskStatus[] = ['open', 'resolve_requested'];
const short = (s: string) => (s.length > 80 ? `${s.slice(0, 77)}...` : s);

// ---------------- admin side (task.manage / task.view) ----------------

/** FR-TASK-001. Idempotent by clientId. Unknown, inactive, non-staff and out-of-scope people all get the same answer. */
export async function create(actor: AuthUser, input: z.infer<typeof createSchema>, meta: RequestMeta): Promise<{ statusCode: 200 | 201; body: TaskView }> {
  if (input.clientId) {
    const prior = (await TaskModel.findOne({ createdBy: actor.id, clientId: input.clientId }).lean()) as Lean | null;
    if (prior) return { statusCode: 200, body: await view(prior) };
  }
  const assignee = isOid(input.assigneeId) ? await getUser(input.assigneeId) : null;
  if (!assignee || !assignee.active || assignee.role !== 'field_staff') throw businessRule('TASK_INVALID_ASSIGNEE');
  const branchId = input.branchId ?? assignee.branchIds.find((b) => canSeeBranch(actor, b));
  if (!branchId || !assignee.branchIds.includes(branchId) || !canSeeBranch(actor, branchId)) throw businessRule('TASK_INVALID_ASSIGNEE');
  const at = now();
  if (input.dueDate && input.dueDate < businessDate(at)) throw businessRule('TASK_DUE_IN_PAST');

  let doc: Lean;
  try {
    doc = await withTransaction(async (session) => {
      const [created] = await TaskModel.create(
        [{ branchId, assigneeId: assignee.id, createdBy: actor.id, title: input.title, note: input.note ?? null, dueDate: input.dueDate ?? null, status: 'open', events: [eventOf('created', actor.id, at, null)], clientId: input.clientId ?? null, createdAt: at, updatedAt: at }],
        { session },
      );
      const t = created!.toObject() as Lean;
      await changed(t, session);
      await audit.record({ actor, action: 'task.created', entity: 'task', entityId: idOf(t), branchId, after: { assigneeId: assignee.id, title: input.title, dueDate: input.dueDate ?? null }, meta }, session);
      return t;
    });
  } catch (err) {
    // Two taps of the same button race to the unique (createdBy, clientId) index: the loser returns the winner's task.
    const prior = input.clientId && isDuplicateKey(err) ? ((await TaskModel.findOne({ createdBy: actor.id, clientId: input.clientId }).lean()) as Lean | null) : null;
    if (!prior) throw err;
    return { statusCode: 200, body: await view(prior) };
  }
  await ctx().bus.emit('task.assigned', { taskId: idOf(doc), branchId, assigneeId: assignee.id, title: short(input.title), createdBy: actor.id });
  return { statusCode: 201, body: await view(doc) };
}

/** Scope: a manager sees tasks of their branches; out-of-scope is 404 (CLAUDE.md §2.7). */
async function scoped(actor: AuthUser, id: string): Promise<Lean> {
  if (!isOid(id)) throw notFound('task');
  const t = (await TaskModel.findOne({ _id: id, ...branchQuery(actor, undefined) }).lean()) as Lean | null;
  if (!t) throw notFound('task');
  return t;
}

export async function list(actor: AuthUser, q: z.infer<typeof listQuery>) {
  const base: Record<string, unknown> = { ...branchQuery(actor, q.branchId), ...(q.assigneeId ? { assigneeId: q.assigneeId } : {}), ...(q.q ? { title: { $regex: q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } } : {}) };
  const today = businessDate(now());
  const f: Record<string, unknown> = { ...base, ...(q.status ? { status: q.status } : {}) };
  if (q.overdue) {
    // Overdue only means something for work that is still going; a closed task asked for as overdue matches nothing.
    f.dueDate = { $lt: today };
    f.status = q.status ? (ACTIVE.includes(q.status) ? q.status : { $in: [] }) : { $in: ACTIVE };
  }
  const cur = decodeCursor<{ id: string }>(q.cursor);
  const rows = (await TaskModel.find({ ...f, ...(cur ? { _id: { $lt: cur.id } } : {}) }).sort({ _id: -1 }).limit(q.limit + 1).lean()) as Lean[];
  const items = rows.slice(0, q.limit);
  // Tab badges: how many tasks are in each state for the same branch / person / search, whatever tab is open.
  const grouped = (await TaskModel.aggregate([{ $match: base }, { $group: { _id: '$status', n: { $sum: 1 } } }])) as { _id: TaskStatus; n: number }[];
  const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, grouped.find((g) => g._id === s)?.n ?? 0])) as Record<TaskStatus, number>;
  const overdue = await TaskModel.countDocuments({ ...base, status: { $in: ACTIVE }, dueDate: { $lt: today } });
  return { items: await views(items), nextCursor: rows.length > q.limit ? encodeCursor({ id: idOf(items[items.length - 1]!) }) : null, counts: { ...counts, overdue } };
}

export async function get(actor: AuthUser, id: string) {
  return view(await scoped(actor, id));
}

export async function edit(actor: AuthUser, id: string, input: z.infer<typeof editSchema>, meta: RequestMeta) {
  const t = await scoped(actor, id);
  if (!transition(t.status, 'edit')) throw invalidState(`TASK_${String(t.status).toUpperCase()}`);
  if (input.dueDate && input.dueDate < businessDate(now())) throw businessRule('TASK_DUE_IN_PAST');
  const at = now();
  const set: Record<string, unknown> = { updatedAt: at, ...(input.title !== undefined ? { title: input.title } : {}), ...(input.note !== undefined ? { note: input.note || null } : {}), ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}) };
  const next = await withTransaction(async (session) => {
    const doc = (await TaskModel.findOneAndUpdate({ _id: id, status: 'open' }, { $set: set, $push: { events: eventOf('edited', actor.id, at, null) } }, { new: true, session }).lean()) as Lean | null;
    if (!doc) return null;
    await changed(doc, session);
    await audit.record({ actor, action: 'task.edited', entity: 'task', entityId: id, branchId: doc.branchId, before: { title: t.title, dueDate: t.dueDate ?? null }, after: { title: doc.title, dueDate: doc.dueDate ?? null }, meta }, session);
    return doc;
  });
  // Someone moved the task (the staff member just asked to resolve it): the caller sees the state and decides again.
  if (!next) throw invalidState('TASK_CHANGED');
  return view(next);
}

/** Admin decision (verify / reject / cancel). Verify and cancel are idempotent; reject needs a reason. */
async function decide(actor: AuthUser, id: string, action: 'verify' | 'reject' | 'cancel', note: string | null, meta: RequestMeta) {
  const t = await scoped(actor, id);
  const tr = transition(t.status, action);
  if (!tr) throw invalidState(`TASK_${String(t.status).toUpperCase()}`);
  if (tr.replay) return view(t);
  const at = now();
  const past = { verify: 'verified', reject: 'rejected', cancel: 'cancelled' } as const;
  const set: Record<string, unknown> = { status: tr.to, decisionNote: note, decidedBy: actor.id, decidedAt: at, updatedAt: at, ...(action === 'reject' ? { resolveNote: null, resolveRequestedAt: null } : {}) };
  const next = await withTransaction(async (session) => {
    const doc = (await TaskModel.findOneAndUpdate({ _id: id, status: t.status }, { $set: set, $push: { events: eventOf(past[action], actor.id, at, note) } }, { new: true, session }).lean()) as Lean | null;
    if (!doc) return null;
    await changed(doc, session);
    await audit.record({ actor, action: `task.${past[action]}`, entity: 'task', entityId: id, branchId: doc.branchId, before: { status: t.status }, after: { status: tr.to }, reason: note, meta }, session);
    return doc;
  });
  if (!next) throw invalidState('TASK_CHANGED');
  await ctx().bus.emit(`task.${past[action]}`, { taskId: id, branchId: next.branchId, assigneeId: next.assigneeId, title: short(next.title), ...(note ? { note } : {}) });
  return view(next);
}

export const verify = (actor: AuthUser, id: string, note: string | undefined, meta: RequestMeta) => decide(actor, id, 'verify', note || null, meta);
export const cancel = (actor: AuthUser, id: string, note: string | undefined, meta: RequestMeta) => decide(actor, id, 'cancel', note || null, meta);
export function reject(actor: AuthUser, id: string, reason: string | undefined, meta: RequestMeta) {
  // The staff member has to know what is missing, so a reason is required (same rule as rejecting leave).
  if ((reason ?? '').trim().length < 5) throw businessRule('REASON_REQUIRED');
  return decide(actor, id, 'reject', reason!.trim(), meta);
}

// ---------------- staff side (task.work) ----------------

/** FR-TASK-002. The assignee says the work is done; an admin verifies. Idempotent, so an offline retry is harmless. */
export async function requestResolve(user: AuthUser, id: string, input: z.infer<typeof resolveRequestSchema>, meta: RequestMeta) {
  if (!isOid(id)) throw notFound('task');
  const t = (await TaskModel.findOne({ _id: id, assigneeId: user.id }).lean()) as Lean | null;
  if (!t) throw notFound('task');
  const tr = transition(t.status, 'request_resolve');
  if (!tr) throw invalidState(`TASK_${String(t.status).toUpperCase()}`);
  if (tr.replay) return view(t);
  const serverNow = now();
  // An offline phone sends the time the button was tapped; it can never be in the future or before the task existed.
  const tapped = input.requestedAt ? new Date(input.requestedAt) : serverNow;
  const at = tapped > serverNow ? serverNow : tapped < (t.createdAt as Date) ? serverNow : tapped;
  const note = input.note || null;
  const next = await withTransaction(async (session) => {
    const doc = (await TaskModel.findOneAndUpdate({ _id: id, assigneeId: user.id, status: 'open' }, { $set: { status: 'resolve_requested', resolveNote: note, resolveRequestedAt: at, updatedAt: serverNow }, $push: { events: eventOf('resolve_requested', user.id, at, note) } }, { new: true, session }).lean()) as Lean | null;
    if (!doc) return null;
    await changed(doc, session);
    await audit.record({ actor: user, action: 'task.resolve_requested', entity: 'task', entityId: id, branchId: doc.branchId, before: { status: 'open' }, after: { status: 'resolve_requested' }, reason: note, meta }, session);
    return doc;
  });
  if (!next) return view((await TaskModel.findById(id).lean()) as Lean); // lost a race with a cancel: the staff member sees the real state
  await ctx().bus.emit('task.resolve_requested', { taskId: id, branchId: next.branchId, assigneeId: user.id, assigneeName: user.name.en || user.name.bn || '', title: short(next.title) });
  return view(next);
}

/** The caller's own tasks: everything still going, plus what was closed in the last 30 days. Newest first. */
export async function mine(user: AuthUser) {
  const since = addDays(businessDate(now()), -30);
  const rows = (await TaskModel.find({ assigneeId: user.id, $or: [{ status: { $in: ACTIVE } }, { updatedAt: { $gte: startOfBusinessDay(since) } }] }).sort({ _id: -1 }).limit(200).lean()) as Lean[];
  return { items: await views(rows) };
}

/** Sync loader: a task travels only to the person it was given to. */
export async function syncLoad(ids: string[], user: AuthUser): Promise<Map<string, Record<string, unknown>>> {
  const rows = (await TaskModel.find({ _id: { $in: ids.filter(isOid) }, assigneeId: user.id }).lean()) as Lean[];
  return new Map((await views(rows)).map((v) => [v.id, v]));
}
