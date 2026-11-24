import { z } from 'zod';
import { Types, type ClientSession } from 'mongoose';
import { ctx } from '../../core/context/index.js';
import { AppError, forbidden, invalidState, notFound } from '../../core/errors/index.js';
import { isDuplicateKey, isOid, withTransaction, type LeanDoc } from '../../core/db/index.js';
import { recordChange } from '../../core/changefeed/index.js';
import { decodeCursor, encodeCursor } from '../../core/http/index.js';
import type { RequestMeta } from '../../core/http/router.js';
import { addDays, businessDate, isIsoDate } from '../../core/time/index.js';
import { branchFilter, branchQuery, canSeeBranch, type AuthUser } from '../../core/security/types.js';
import * as audit from '../audit/index.js';
import { can, effectivePermissions, holdersOf } from '../rbac/index.js';
import { getBranch } from '../branches/index.js';
import { getCustomerRef } from '../customers/index.js';
import { isUploadedBy } from '../media/index.js';
import { getUser } from '../users/index.js';
import {
  checkAction,
  escapeRegex,
  levelFor,
  mayAct,
  MAX_PHOTOS,
  OPEN_STATUSES,
  PRIORITIES,
  QUEUES,
  queueAudience,
  REQUEST_TYPES,
  SNAPSHOT_CLOSED_DAYS,
  statusAfter,
  STATUSES,
  type Action,
  type Level,
  type Queue,
  type RequestStatus,
  type TimelineKind,
} from './domain/rules.js';
import { RequestModel } from './models/request.model.js';

type Lean = LeanDoc;
export const VIEW = 'request.view';
export const CREATE = 'request.create';
export const MANAGE = 'request.manage';
export const TOP = 'request.important.manage';

const now = () => ctx().clock.now();
const idOf = (r: Lean): string => r._id.toHexString();
const iso = (d: unknown): string | null => (d ? (d as Date).toISOString() : null);
interface Person {
  id: string;
  name: string;
}
const person = (u: { id: string; name: { en?: string; bn?: string } }): Person => ({ id: u.id, name: u.name.en || u.name.bn || '' });
const personOf = (p: unknown): Person | null => {
  if (!p) return null;
  const x = p as { id: string; name?: string | null };
  return { id: x.id, name: x.name ?? '' };
};
interface Target {
  queue: Queue;
  user: Person | null;
}

// ---------------- input (zod; the same schemas serve REST and /sync/push) ----------------

const day = z.string().refine(isIsoDate, 'YYYY-MM-DD');
const note = z.string().trim().min(1).max(1000);

export const createSchema = z.object({
  clientId: z.string().uuid(),
  type: z.enum(REQUEST_TYPES),
  priority: z.enum(PRIORITIES),
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(4000),
  customerId: z.string().max(64).optional(),
  photoMediaIds: z.array(z.string().max(64)).max(MAX_PHOTOS).optional(),
  dueAt: z.string().datetime({ offset: true }).optional(),
  branchId: z.string().max(64).optional(),
});
export type RequestCreate = z.infer<typeof createSchema>;

export const commentSchema = z.object({ clientId: z.string().uuid(), text: z.string().trim().min(1).max(2000) });
/** Sync mutation `request_comment`: the request by server id, or by the clientId of a request sent before it. */
export const syncCommentSchema = commentSchema
  .extend({ requestId: z.string().max(64).optional(), requestClientId: z.string().uuid().optional() })
  .refine((v) => !!v.requestId || !!v.requestClientId, { message: 'requestId or requestClientId is required', path: ['requestId'] });

export const forwardSchema = z
  .object({ queue: z.enum(['area_manager', 'super_admin']).optional(), userId: z.string().max(64).optional(), note })
  .refine((v) => !!v.queue !== !!v.userId, { message: 'exactly one of queue / userId', path: ['queue'] });
export const assignSchema = z.object({ userId: z.string().min(1).max(64), note: z.string().trim().max(1000).optional() });
export const noteSchema = z.object({ note });
export const closeSchema = z.object({ note: z.string().trim().max(1000).optional() });

const statusList = z
  .string()
  .max(200)
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(z.enum(STATUSES)).min(1));

export const listQuery = z
  .object({
    branchId: z.string().max(64).optional(),
    from: day.optional(),
    to: day.optional(),
    status: statusList.optional(),
    priority: z.enum(PRIORITIES).optional(),
    type: z.enum(REQUEST_TYPES).optional(),
    queue: z.enum(QUEUES).optional(),
    assigneeId: z.string().max(64).optional(),
    createdBy: z.string().max(64).optional(),
    customerId: z.string().max(64).optional(),
    q: z.string().trim().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(200).optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: '`from` is after `to`', path: ['from'] });
export type ListQuery = z.infer<typeof listQuery>;

// ---------------- representation ----------------

const targetOf = (t: unknown): Target | null => {
  if (!t) return null;
  const x = t as { queue: Queue; user?: unknown };
  return { queue: x.queue, user: personOf(x.user) };
};

export function view(r: Lean) {
  return {
    id: idOf(r),
    clientId: r.clientId as string,
    type: r.type as (typeof REQUEST_TYPES)[number],
    priority: r.priority as (typeof PRIORITIES)[number],
    title: r.title as string,
    body: r.body as string,
    customerId: (r.customerId as string | null) ?? null,
    photoMediaIds: (r.photoMediaIds as string[] | undefined) ?? [],
    branchId: r.branchId as string,
    createdBy: personOf(r.createdBy)!,
    createdAt: iso(r.createdAt)!,
    createdDate: r.createdDate as string,
    status: r.status as RequestStatus,
    currentQueue: r.currentQueue as Queue,
    level: r.level as Level,
    assignee: personOf(r.assignee),
    dueAt: iso(r.dueAt),
    resolvedAt: iso(r.resolvedAt),
    resolvedBy: personOf(r.resolvedBy),
    resolutionNote: (r.resolutionNote as string | null) ?? null,
    closedAt: iso(r.closedAt),
    timeline: ((r.timeline ?? []) as Lean[]).map((e) => ({
      id: e.id as string,
      kind: e.kind as TimelineKind,
      at: iso(e.at)!,
      actor: personOf(e.actor)!,
      note: (e.note as string | null) ?? null,
      from: targetOf(e.from),
      to: targetOf(e.to),
      status: e.status ? { from: ((e.status as { from?: string | null }).from ?? null) as RequestStatus | null, to: (e.status as { to: RequestStatus }).to } : null,
    })),
    updatedAt: iso(r.updatedAt)!,
    version: r.version as number,
  };
}
export type RequestView = ReturnType<typeof view>;

/** What the audit log keeps: the routing facts, not the text (which can hold personal details). */
const auditView = (r: Lean) => ({
  type: r.type,
  priority: r.priority,
  status: r.status,
  level: r.level,
  currentQueue: r.currentQueue,
  assigneeId: (r.assignee as { id?: string } | null)?.id ?? null,
  branchId: r.branchId,
});

// ---------------- scope (CLAUDE.md §2.7) ----------------

/** Their own requests and the ones assigned to them now: what every request.create holder sees (and the app pulls). */
const mineFilter = (user: AuthUser): Record<string, unknown> => ({ $or: [{ 'createdBy.id': user.id }, { 'assignee.id': user.id }] });

/** request.view: the caller's branches (every branch for all-branch roles), plus their own; otherwise only their own. */
async function readFilter(user: AuthUser): Promise<Record<string, unknown>> {
  if (!(await can(user, VIEW))) return mineFilter(user);
  const branches = branchFilter(user);
  if (!Object.keys(branches).length) return {};
  return { $or: [branches, ...(mineFilter(user).$or as Record<string, unknown>[])] };
}

async function load(user: AuthUser, id: string): Promise<Lean> {
  if (!isOid(id)) throw notFound('request');
  const r = (await RequestModel.findOne({ _id: id, ...(await readFilter(user)) }).lean()) as Lean | null;
  if (!r) throw notFound('request');
  return r;
}

// ---------------- recipients ----------------

async function audienceOf(level: Level): Promise<string[]> {
  const [manage, top] = await Promise.all([holdersOf(MANAGE, null), holdersOf(TOP, null)]);
  return queueAudience(level, { manage, top });
}

/** Who is told about where a request now waits: the assignee, else the queue. */
async function waitingWith(r: Lean): Promise<string[]> {
  const a = personOf(r.assignee);
  return a ? [a.id] : audienceOf(r.level as Level);
}

const without = (ids: string[], actor: AuthUser) => [...new Set(ids)].filter((id) => id && id !== actor.id);

// ---------------- writes ----------------

const validation = (fields: { path: string; message: string }[]) => new AppError('VALIDATION_FAILED', { fields });
const entry = (kind: TimelineKind, at: Date, actor: AuthUser, extra: { note?: string | null; from?: Target | null; to?: Target | null; status?: { from: RequestStatus | null; to: RequestStatus } | null; clientId?: string | null } = {}) => ({
  id: new Types.ObjectId().toHexString(),
  kind,
  at,
  actor: person(actor),
  note: extra.note ?? null,
  from: extra.from ?? null,
  to: extra.to ?? null,
  status: extra.status ?? null,
  clientId: extra.clientId ?? null,
});

/** The creator's and every (former) assignee's device hears about each change; the loader decides what they keep. */
const touch = (r: Lean, session: ClientSession, extra: string[] = []) =>
  recordChange({ entity: 'request', entityId: idOf(r), userIds: [...((r.participantIds as string[]) ?? []), ...extra], branchId: r.branchId as string }, session);

/** Field staff always get their home branch; office users (request.view) may name a branch in their scope. */
async function branchFor(user: AuthUser, requested: string | undefined): Promise<string> {
  if (requested && (await can(user, VIEW))) {
    if (!canSeeBranch(user, requested) || !(await getBranch(requested))) throw validation([{ path: 'branchId', message: 'unknown branch or out of scope' }]);
    return requested;
  }
  const home = user.branchIds[0];
  if (!home) throw validation([{ path: 'branchId', message: 'required for a user without a branch' }]);
  return home;
}

/** Signals for the inbox (`request.important` item): waiting in the super admin queue, or not any more. */
async function signalTop(r: Lean, before: { waiting: boolean }): Promise<void> {
  const waiting = r.currentQueue === 'super_admin' && OPEN_STATUSES.includes(r.status as RequestStatus);
  if (waiting && !before.waiting) await ctx().bus.emit('request.top_waiting', { requestId: idOf(r), title: r.title });
  if (!waiting && before.waiting) await ctx().bus.emit('request.top_cleared', { requestId: idOf(r) });
}
const isWaitingAtTop = (r: Lean) => r.currentQueue === 'super_admin' && OPEN_STATUSES.includes(r.status as RequestStatus);

/** POST /requests and the sync mutation `request` (FR-REQ-001). Idempotent by clientId. */
export async function create(user: AuthUser, input: RequestCreate, meta: RequestMeta): Promise<{ statusCode: 200 | 201; body: RequestView }> {
  const prior = (await RequestModel.findOne({ clientId: input.clientId }).lean()) as Lean | null;
  if (prior) {
    if ((prior.createdBy as { id: string }).id !== user.id) throw new AppError('IDEMPOTENCY_MISMATCH', { clientId: input.clientId });
    return { statusCode: 200, body: view(prior) };
  }
  const branchId = await branchFor(user, input.branchId);
  if (input.customerId && !(await getCustomerRef(user, input.customerId))) throw validation([{ path: 'customerId', message: 'unknown customer or out of scope' }]);
  const photos = [...new Set(input.photoMediaIds ?? [])];
  for (const [i, m] of photos.entries())
    if (!(await isUploadedBy(m, user.id))) throw validation([{ path: `photoMediaIds.${i}`, message: 'not a photo you uploaded' }]);
  const at = now();
  const level = levelFor(input.priority);
  let doc: Lean;
  try {
    doc = await withTransaction(async (session) => {
      const [created] = await RequestModel.create(
        [
          {
            clientId: input.clientId,
            type: input.type,
            priority: input.priority,
            title: input.title,
            body: input.body,
            customerId: input.customerId ?? null,
            photoMediaIds: photos,
            branchId,
            createdBy: person(user),
            createdAt: at,
            createdDate: businessDate(at),
            status: 'open',
            level,
            currentQueue: level,
            assignee: null,
            participantIds: [user.id],
            dueAt: input.dueAt ? new Date(input.dueAt) : null,
            timeline: [entry('created', at, user, { to: { queue: level, user: null }, status: { from: null, to: 'open' } })],
            updatedAt: at,
            version: 1,
          },
        ],
        { session },
      );
      const r = created!.toObject() as Lean;
      await touch(r, session);
      await audit.record({ actor: user, action: 'request.created', entity: 'request', entityId: idOf(r), branchId, after: auditView(r), meta }, session);
      return r;
    });
  } catch (err) {
    // Two sends of the same offline row race to the unique clientId index: the loser answers with the winner.
    if (isDuplicateKey(err)) return create(user, input, meta);
    throw err;
  }
  await ctx().bus.emit('request.created', {
    requestId: idOf(doc),
    branchId,
    title: doc.title,
    priority: doc.priority,
    level,
    byName: person(user).name,
    toUserIds: without(await audienceOf(level), user),
  });
  await signalTop(doc, { waiting: false });
  return { statusCode: 201, body: view(doc) };
}

/** Applies one change on the version that was read; a lost race is 409 INVALID_STATE REQUEST_CHANGED (read again). */
async function write(user: AuthUser, r: Lean, update: Record<string, unknown>, action: string, reason: string | null, meta: RequestMeta, extraParticipants: string[] = []): Promise<Lean> {
  const next = await withTransaction(async (session) => {
    const doc = (await RequestModel.findOneAndUpdate({ _id: r._id, version: r.version }, { ...update, $inc: { version: 1 } }, { new: true, session }).lean()) as Lean | null;
    if (!doc) return null;
    // The former assignee hears too, so the request leaves their device when it is no longer theirs.
    await touch(doc, session, extraParticipants);
    await audit.record({ actor: user, action, entity: 'request', entityId: idOf(doc), branchId: doc.branchId, before: auditView(r), after: auditView(doc), reason, meta }, session);
    return doc;
  });
  if (!next) throw invalidState('REQUEST_CHANGED');
  return next;
}

/** The person a request is forwarded or assigned to: active and able to work with requests (FR-REQ-004). */
async function targetUser(userId: string): Promise<Person> {
  const u = await getUser(userId);
  const perms = u && u.active ? await effectivePermissions(u) : null;
  if (!u || !perms || !(perms.has(CREATE) || perms.has(MANAGE) || perms.has(TOP)))
    throw new AppError('BUSINESS_RULE', { rule: 'REQUEST_INVALID_TARGET', userId });
  return person(u);
}

async function authorize(user: AuthUser, r: Lean, action: Exclude<Action, 'comment'>): Promise<void> {
  const rule = checkAction(action, r.status as RequestStatus);
  if (!rule.ok) throw invalidState(rule.reason, { status: r.status });
  const [manage, top] = await Promise.all([can(user, MANAGE), can(user, TOP)]);
  const who = { manage, top, isCreator: (r.createdBy as { id: string }).id === user.id, isAssignee: personOf(r.assignee)?.id === user.id };
  if (!mayAct(action, who, r.level as Level)) throw forbidden(r.level === 'super_admin' ? TOP : MANAGE);
}

const here = (r: Lean): Target => ({ queue: r.currentQueue as Queue, user: personOf(r.assignee) });

interface Moved {
  doc: Lean;
  before: Lean;
}

async function move(user: AuthUser, id: string, action: 'forward' | 'assign', to: { queue: Level } | { userId: string }, noteText: string | null, meta: RequestMeta): Promise<Moved> {
  const r = await load(user, id);
  await authorize(user, r, action);
  const at = now();
  const status = statusAfter(action, r.status as RequestStatus);
  let set: Record<string, unknown>;
  let dest: Target;
  if ('queue' in to) {
    set = { level: to.queue, currentQueue: to.queue, assignee: null };
    dest = { queue: to.queue, user: null };
  } else {
    const p = await targetUser(to.userId);
    set = { currentQueue: 'assignee', assignee: p };
    dest = { queue: 'assignee', user: p };
  }
  const kind: TimelineKind = action === 'forward' ? 'forwarded' : 'assigned';
  const doc = await write(
    user,
    r,
    {
      $set: { ...set, status, updatedAt: at },
      $push: { timeline: entry(kind, at, user, { note: noteText, from: here(r), to: dest, status: status !== r.status ? { from: r.status as RequestStatus, to: status } : null }) },
      ...(dest.user ? { $addToSet: { participantIds: dest.user.id } } : {}),
    },
    action === 'forward' ? 'request.forwarded' : 'request.assigned',
    noteText,
    meta,
  );
  return { doc, before: r };
}

/** POST /requests/{id}/forward (FR-REQ-003): to a queue or a person, with a note. */
export async function forward(user: AuthUser, id: string, input: z.infer<typeof forwardSchema>, meta: RequestMeta): Promise<RequestView> {
  const { doc, before } = await move(user, id, 'forward', input.queue ? { queue: input.queue } : { userId: input.userId! }, input.note, meta);
  await ctx().bus.emit('request.forwarded', { requestId: id, branchId: doc.branchId, title: doc.title, byName: person(user).name, note: input.note, toUserIds: without(await waitingWith(doc), user) });
  await signalTop(doc, { waiting: isWaitingAtTop(before) });
  return view(doc);
}

/** POST /requests/{id}/assign: to a person; status in_progress. */
export async function assign(user: AuthUser, id: string, input: z.infer<typeof assignSchema>, meta: RequestMeta): Promise<RequestView> {
  const { doc, before } = await move(user, id, 'assign', { userId: input.userId }, input.note || null, meta);
  await ctx().bus.emit('request.assigned', { requestId: id, branchId: doc.branchId, title: doc.title, byName: person(user).name, note: input.note ?? '', toUserIds: without(await waitingWith(doc), user) });
  await signalTop(doc, { waiting: isWaitingAtTop(before) });
  return view(doc);
}

/** POST /requests/{id}/resolve: note required; the creator is told. */
export async function resolve(user: AuthUser, id: string, noteText: string, meta: RequestMeta): Promise<RequestView> {
  const r = await load(user, id);
  await authorize(user, r, 'resolve');
  const at = now();
  const doc = await write(
    user,
    r,
    {
      $set: { status: 'resolved', resolvedAt: at, resolvedBy: person(user), resolutionNote: noteText, updatedAt: at },
      $push: { timeline: entry('resolved', at, user, { note: noteText, status: { from: r.status as RequestStatus, to: 'resolved' } }) },
    },
    'request.resolved',
    noteText,
    meta,
  );
  const creator = (doc.createdBy as { id: string }).id;
  await ctx().bus.emit('request.resolved', { requestId: id, branchId: doc.branchId, title: doc.title, byName: person(user).name, note: noteText, toUserIds: without([creator], user) });
  await signalTop(doc, { waiting: isWaitingAtTop(r) });
  return view(doc);
}

/** POST /requests/{id}/reopen: back to where it was (queue or assignee); the creator or the office. */
export async function reopen(user: AuthUser, id: string, noteText: string, meta: RequestMeta): Promise<RequestView> {
  const r = await load(user, id);
  await authorize(user, r, 'reopen');
  const at = now();
  const doc = await write(
    user,
    r,
    {
      $set: { status: 'reopened', resolvedAt: null, resolvedBy: null, resolutionNote: null, closedAt: null, closedDate: null, updatedAt: at },
      $push: { timeline: entry('reopened', at, user, { note: noteText, to: here(r), status: { from: r.status as RequestStatus, to: 'reopened' } }) },
    },
    'request.reopened',
    noteText,
    meta,
  );
  const creator = (doc.createdBy as { id: string }).id;
  await ctx().bus.emit('request.reopened', { requestId: id, branchId: doc.branchId, title: doc.title, byName: person(user).name, note: noteText, toUserIds: without([...(await waitingWith(doc)), creator], user) });
  await signalTop(doc, { waiting: false });
  return view(doc);
}

/** POST /requests/{id}/close: final until reopened; the office, or the creator withdrawing their own. */
export async function close(user: AuthUser, id: string, noteText: string | null, meta: RequestMeta): Promise<RequestView> {
  const r = await load(user, id);
  await authorize(user, r, 'close');
  const at = now();
  const doc = await write(
    user,
    r,
    {
      $set: { status: 'closed', closedAt: at, closedDate: businessDate(at), updatedAt: at },
      $push: { timeline: entry('closed', at, user, { note: noteText, status: { from: r.status as RequestStatus, to: 'closed' } }) },
    },
    'request.closed',
    noteText,
    meta,
  );
  const creator = (doc.createdBy as { id: string }).id;
  await ctx().bus.emit('request.closed', { requestId: id, branchId: doc.branchId, title: doc.title, byName: person(user).name, note: noteText ?? '', toUserIds: without([creator], user) });
  await signalTop(doc, { waiting: isWaitingAtTop(r) });
  return view(doc);
}

/**
 * POST /requests/{id}/comment and the sync mutation `request_comment`: anyone who can see the request. Idempotent by
 * the comment clientId: the same clientId again changes nothing and answers the request as it is.
 */
export async function comment(user: AuthUser, id: string, input: z.infer<typeof commentSchema>, meta: RequestMeta): Promise<{ replayed: boolean; body: RequestView }> {
  const r = await load(user, id);
  if (((r.timeline ?? []) as Lean[]).some((e) => e.clientId === input.clientId)) return { replayed: true, body: view(r) };
  const rule = checkAction('comment', r.status as RequestStatus);
  if (!rule.ok) throw invalidState(rule.reason, { status: r.status });
  const at = now();
  const doc = await withTransaction(async (session) => {
    // Conditional on the comment not being there yet, so two sends of one offline comment add it once.
    const d = (await RequestModel.findOneAndUpdate(
      { _id: r._id, status: { $ne: 'closed' }, 'timeline.clientId': { $ne: input.clientId } },
      { $push: { timeline: entry('comment', at, user, { note: input.text, clientId: input.clientId }) }, $set: { updatedAt: at }, $inc: { version: 1 } },
      { new: true, session },
    ).lean()) as Lean | null;
    if (!d) return null;
    await touch(d, session);
    await audit.record({ actor: user, action: 'request.commented', entity: 'request', entityId: idOf(d), branchId: d.branchId, after: { commentClientId: input.clientId, length: input.text.length }, meta }, session);
    return d;
  });
  if (!doc) {
    const again = await load(user, id);
    if (((again.timeline ?? []) as Lean[]).some((e) => e.clientId === input.clientId)) return { replayed: true, body: view(again) };
    throw invalidState('REQUEST_CLOSED', { status: again.status });
  }
  const to = [(doc.createdBy as { id: string }).id, ...(personOf(doc.assignee) ? [personOf(doc.assignee)!.id] : [])];
  await ctx().bus.emit('request.commented', { requestId: id, branchId: doc.branchId, title: doc.title, byName: person(user).name, toUserIds: without(to, user) });
  return { replayed: false, body: view(doc) };
}

/** Sync `request_comment`: finds the request by id or by the clientId the app created it with. */
export async function commentFromSync(user: AuthUser, input: z.infer<typeof syncCommentSchema>, meta: RequestMeta) {
  let id = input.requestId;
  if (!id) {
    const r = (await RequestModel.findOne({ clientId: input.requestClientId }, { _id: 1 }).lean()) as Lean | null;
    if (!r) throw notFound('request');
    id = idOf(r);
  }
  return comment(user, id, { clientId: input.clientId, text: input.text }, meta);
}

// ---------------- reads ----------------

export async function get(user: AuthUser, id: string): Promise<RequestView> {
  return view(await load(user, id));
}

/** The list filter of GET /requests without `status`, also used by the dashboard counters (same scope). */
async function baseFilter(user: AuthUser, q: Omit<ListQuery, 'limit' | 'cursor' | 'status'>): Promise<Record<string, unknown>> {
  const and: Record<string, unknown>[] = [await readFilter(user)];
  if (q.branchId) and.push(branchQuery(user, q.branchId));
  if (q.from || q.to) and.push({ createdDate: { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) } });
  if (q.priority) and.push({ priority: q.priority });
  if (q.type) and.push({ type: q.type });
  if (q.queue) and.push({ currentQueue: q.queue });
  if (q.assigneeId) and.push({ 'assignee.id': q.assigneeId === 'me' ? user.id : q.assigneeId });
  if (q.createdBy) and.push({ 'createdBy.id': q.createdBy });
  if (q.customerId) and.push({ customerId: q.customerId });
  if (q.q) {
    const rx = { $regex: escapeRegex(q.q), $options: 'i' };
    and.push({ $or: [{ title: rx }, { body: rx }] });
  }
  return { $and: and };
}

/** GET /requests: newest first, paged by id, with the total of all pages and the counts per status. */
export async function list(user: AuthUser, q: ListQuery) {
  const base = await baseFilter(user, q);
  const f = q.status ? { $and: [base, { status: { $in: q.status } }] } : base;
  const cur = decodeCursor<{ id: string }>(q.cursor);
  const [rows, total, grouped] = await Promise.all([
    RequestModel.find({ ...f, ...(cur && isOid(cur.id) ? { _id: { $lt: new Types.ObjectId(cur.id) } } : {}) })
      .sort({ _id: -1 })
      .limit(q.limit + 1)
      .lean() as Promise<Lean[]>,
    RequestModel.countDocuments(f),
    RequestModel.aggregate<{ _id: RequestStatus; n: number }>([{ $match: base }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<RequestStatus, number>;
  for (const g of grouped) counts[g._id] = g.n;
  const items = rows.slice(0, q.limit);
  return { items: items.map(view), nextCursor: rows.length > q.limit ? encodeCursor({ id: idOf(items[items.length - 1]!) }) : null, total, counts };
}

/** Dashboard counters (contract 1.48.0 `requestStats`): not resolved or closed, by where they wait; important ones. */
export async function dashboardStats(user: AuthUser, branchId: string | undefined) {
  const base = await baseFilter(user, branchId ? { branchId } : {});
  const open = { $and: [base, { status: { $in: OPEN_STATUSES } }] };
  const count = (extra: Record<string, unknown>) => RequestModel.countDocuments({ $and: [open, extra] });
  const [areaManagerQueue, superAdminQueue, assigned, importantOpen] = await Promise.all([
    count({ currentQueue: 'area_manager' }),
    count({ currentQueue: 'super_admin' }),
    count({ currentQueue: 'assignee' }),
    count({ priority: 'important' }),
  ]);
  return { areaManagerQueue, superAdminQueue, assigned, importantOpen };
}

// ---------------- sync ----------------

/** Loader: what this user may read; anything else becomes a delete on the device. */
export async function syncLoad(ids: string[], user: AuthUser): Promise<Map<string, Record<string, unknown>>> {
  const rows = (await RequestModel.find({ _id: { $in: ids.filter(isOid) }, ...mineFilter(user) }).lean()) as Lean[];
  return new Map(rows.map((r) => [idOf(r), view(r)]));
}

/** Bootstrap: the user's own requests and the ones assigned to them, open or closed in the last 30 Dhaka days. */
export async function snapshot(user: AuthUser, cursor: string | null, limit: number) {
  const cur = decodeCursor<{ id: string }>(cursor ?? undefined);
  const since = addDays(businessDate(now()), -SNAPSHOT_CLOSED_DAYS);
  const rows = (await RequestModel.find({
    $and: [mineFilter(user), { $or: [{ status: { $ne: 'closed' } }, { closedDate: { $gte: since } }] }],
    ...(cur && isOid(cur.id) ? { _id: { $gt: new Types.ObjectId(cur.id) } } : {}),
  })
    .sort({ _id: 1 })
    .limit(limit + 1)
    .lean()) as Lean[];
  const page = rows.slice(0, limit);
  return { items: page.map(view), nextCursor: rows.length > limit ? encodeCursor({ id: idOf(page[page.length - 1]!) }) : null };
}
