import { z } from 'zod';
import type { ClientSession } from 'mongoose';
import { ctx } from '../../core/context/index.js';
import { AppError, invalidState, notFound } from '../../core/errors/index.js';
import { isDuplicateKey, isOid, withTransaction, type LeanDoc } from '../../core/db/index.js';
import { recordChange } from '../../core/changefeed/index.js';
import { decodeCursor, encodeCursor } from '../../core/http/index.js';
import type { RequestMeta } from '../../core/http/router.js';
import { addDays, businessDate, isIsoDate } from '../../core/time/index.js';
import { branchQuery, canSeeBranch, isSuperAdmin, type AuthUser } from '../../core/security/types.js';
import * as audit from '../audit/index.js';
import { can } from '../rbac/index.js';
import { getBranch } from '../branches/index.js';
import { getByErpId, getCustomerRef, searchCustomers, type CustomerRef } from '../customers/index.js';
import {
  changedDetails,
  checkConvert,
  checkReopen,
  checkStatusChange,
  EDITABLE_STATUSES,
  escapeRegex,
  MAX_PHONES,
  normalizePhones,
  OPEN_STATUSES,
  phoneDigits,
  PROSPECT_STATUSES,
  SNAPSHOT_DAYS,
  type Details,
  type Phone,
  type PhoneIn,
  type ProspectStatus,
} from './domain/rules.js';
import { ProspectModel } from './models/prospect.model.js';

type Lean = LeanDoc;
const VIEW = 'prospect.view';
const now = () => ctx().clock.now();
const today = () => businessDate(now());
const idOf = (p: Lean): string => p._id.toHexString();
const iso = (d: unknown): string | null => (d ? (d as Date).toISOString() : null);
const person = (u: AuthUser) => ({ id: u.id, name: u.name.en || u.name.bn || '' });

// ---------------- input (zod; the same schemas serve REST and /sync/push) ----------------

const day = z.string().refine(isIsoDate, 'YYYY-MM-DD');
const phones = z.array(z.object({ number: z.string().trim().min(1).max(30), label: z.string().trim().max(40).nullable().optional() })).max(MAX_PHONES);
const location = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(100_000).nullable().optional() });

export const createSchema = z.object({
  clientId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  phones: phones.optional(),
  address: z.string().trim().max(500).optional(),
  note: z.string().trim().max(1000).optional(),
  location: location.nullable().optional(),
  branchId: z.string().max(64).optional(),
  fromProspectId: z.string().max(64).optional(),
});
export type ProspectCreate = z.infer<typeof createSchema>;

export const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    phones: phones.optional(),
    address: z.string().trim().max(500).nullable().optional(),
    note: z.string().trim().max(1000).nullable().optional(),
    location: location.nullable().optional(),
    status: z.enum(EDITABLE_STATUSES).optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => ['name', 'phones', 'address', 'note', 'location', 'status'].some((k) => k in v), { message: 'nothing to change' });

export const convertSchema = z
  .object({ customerId: z.string().max(64).optional(), erpCustomerCode: z.string().trim().min(1).max(64).optional(), note: z.string().trim().max(500).optional() })
  .refine((v) => !!v.customerId || !!v.erpCustomerCode, { message: 'customerId or erpCustomerCode is required', path: ['customerId'] });

export const reopenSchema = z.object({ reason: z.string().trim().min(5).max(500) });

export const listQuery = z
  .object({
    branchId: z.string().max(64).optional(),
    from: day.optional(),
    to: day.optional(),
    status: z.enum(PROSPECT_STATUSES).optional(),
    createdBy: z.string().max(64).optional(),
    q: z.string().trim().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(200).optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: '`from` is after `to`', path: ['from'] });
export type ListQuery = z.infer<typeof listQuery>;

// ---------------- representation ----------------

const who = (p: unknown) => {
  const x = p as { id: string; name?: string | null };
  return { id: x.id, name: x.name ?? '' };
};

export function view(p: Lean) {
  const loc = p.location as { lat: number; lng: number; accuracyM?: number | null } | null;
  return {
    id: idOf(p),
    clientId: p.clientId as string,
    name: p.name as string,
    phones: ((p.phones ?? []) as Phone[]).map((x) => ({ number: x.number, label: x.label ?? null })),
    address: (p.address as string | null) ?? null,
    note: (p.note as string | null) ?? null,
    location: loc ? { lat: loc.lat, lng: loc.lng, accuracyM: loc.accuracyM ?? null } : null,
    branchId: p.branchId as string,
    createdBy: who(p.createdBy),
    createdAt: iso(p.createdAt)!,
    createdDate: p.createdDate as string,
    status: p.status as ProspectStatus,
    statusChangedAt: iso(p.statusChangedAt)!,
    convertedCustomerId: (p.convertedCustomerId as string | null) ?? null,
    convertedErpCustomerId: (p.convertedErpCustomerId as string | null) ?? null,
    convertedAt: iso(p.convertedAt),
    convertedBy: p.convertedBy ? who(p.convertedBy) : null,
    fromProspectId: (p.fromProspectId as string | null) ?? null,
    history: ((p.history ?? []) as Lean[]).map((h) => ({
      status: h.status as ProspectStatus,
      at: iso(h.at)!,
      by: who(h.by),
      reason: (h.reason as string | null) ?? null,
      convertedCustomerId: (h.convertedCustomerId as string | null) ?? null,
      convertedErpCustomerId: (h.convertedErpCustomerId as string | null) ?? null,
    })),
    updatedAt: iso(p.updatedAt)!,
    version: p.version as number,
  };
}
export type ProspectView = ReturnType<typeof view>;

/** What the audit log keeps: phone numbers are personal data, so only how many and their last four digits. */
const auditView = (p: Lean) => ({
  name: p.name,
  phones: ((p.phones ?? []) as Phone[]).map((x) => `…${x.number.slice(-4)}`),
  address: p.address ?? null,
  status: p.status,
  branchId: p.branchId,
  convertedCustomerId: p.convertedCustomerId ?? null,
  convertedErpCustomerId: p.convertedErpCustomerId ?? null,
});

// ---------------- scope ----------------

/**
 * GET /prospects scope (CLAUDE.md §2.7): prospect.view sees the caller's branches (super admin all); a caller with only
 * prospect.create (field staff) sees the ones they created.
 */
async function readFilter(user: AuthUser): Promise<Record<string, unknown>> {
  if (await can(user, VIEW)) return isSuperAdmin(user) ? {} : { branchId: { $in: user.branchIds } };
  return { 'createdBy.id': user.id };
}

/** A single prospect: prospect.view in scope, or its creator. Out of scope is 404. */
async function itemFilter(user: AuthUser): Promise<Record<string, unknown>> {
  if (!(await can(user, VIEW))) return { 'createdBy.id': user.id };
  return isSuperAdmin(user) ? {} : { $or: [{ branchId: { $in: user.branchIds } }, { 'createdBy.id': user.id }] };
}

/** Office writes (prospect.manage): the caller's branches. */
const manageFilter = (user: AuthUser): Record<string, unknown> => (isSuperAdmin(user) ? {} : { branchId: { $in: user.branchIds } });

async function loadFor(filter: Record<string, unknown>, id: string): Promise<Lean> {
  if (!isOid(id)) throw notFound('prospect');
  const p = (await ProspectModel.findOne({ _id: id, ...filter }).lean()) as Lean | null;
  if (!p) throw notFound('prospect');
  return p;
}

// ---------------- writes ----------------

/** The creator's device learns about every change on its next pull (sync entity `prospect`). */
const touch = (p: Lean, session: ClientSession) =>
  recordChange({ entity: 'prospect', entityId: idOf(p), userIds: [(p.createdBy as { id: string }).id], branchId: p.branchId as string }, session);

const validation = (fields: { path: string; message: string }[]) => new AppError('VALIDATION_FAILED', { fields });

function cleanPhones(input: PhoneIn[] | undefined): Phone[] {
  const r = normalizePhones(input ?? []);
  if (r.invalid.length) throw validation(r.invalid.map((i) => ({ path: `phones.${i}.number`, message: 'Bangladesh mobile number, 01XXXXXXXXX' })));
  return r.phones;
}

const cleanLocation = (l: z.infer<typeof location> | null | undefined) => (l ? { lat: l.lat, lng: l.lng, accuracyM: l.accuracyM ?? null } : null);

/** Field staff always get their home branch; office users (prospect.manage) may name a branch in their scope. */
async function branchFor(user: AuthUser, requested: string | undefined): Promise<string> {
  if (requested && (await can(user, 'prospect.manage'))) {
    if (!canSeeBranch(user, requested) || !(await getBranch(requested))) throw validation([{ path: 'branchId', message: 'unknown branch or out of scope' }]);
    return requested;
  }
  const home = user.branchIds[0];
  if (!home) throw validation([{ path: 'branchId', message: 'required for a user without a branch' }]);
  return home;
}

/** POST /prospects and the sync mutation `prospect` (FR-PRO-001). Idempotent by clientId. */
export async function create(user: AuthUser, input: ProspectCreate, meta: RequestMeta): Promise<{ statusCode: 200 | 201; body: ProspectView }> {
  const prior = (await ProspectModel.findOne({ clientId: input.clientId }).lean()) as Lean | null;
  if (prior) {
    if ((prior.createdBy as { id: string }).id !== user.id) throw new AppError('IDEMPOTENCY_MISMATCH', { clientId: input.clientId });
    return { statusCode: 200, body: view(prior) };
  }
  const phoneList = cleanPhones(input.phones);
  const branchId = await branchFor(user, input.branchId);
  let fromProspectId: string | null = null;
  if (input.fromProspectId) {
    const older = isOid(input.fromProspectId) ? await ProspectModel.exists({ _id: input.fromProspectId, ...(await itemFilter(user)) }) : null;
    if (!older) throw validation([{ path: 'fromProspectId', message: 'unknown prospect' }]);
    fromProspectId = input.fromProspectId;
  }
  const at = now();
  const by = person(user);
  let doc: Lean;
  try {
    doc = await withTransaction(async (session) => {
      const [created] = await ProspectModel.create(
        [
          {
            clientId: input.clientId,
            name: input.name,
            phones: phoneList,
            address: input.address || null,
            note: input.note || null,
            location: cleanLocation(input.location),
            branchId,
            createdBy: by,
            createdAt: at,
            createdDate: businessDate(at),
            status: 'new',
            statusChangedAt: at,
            fromProspectId,
            history: [{ status: 'new', at, by, reason: fromProspectId ? `re-entry of ${fromProspectId}` : null }],
            updatedAt: at,
            version: 1,
          },
        ],
        { session },
      );
      const p = created!.toObject() as Lean;
      await touch(p, session);
      // Office entries are audited; a staff member's own field record is not an office action (FR-AUD-001).
      if (user.client === 'web') await audit.record({ actor: user, action: 'prospect.created', entity: 'prospect', entityId: idOf(p), branchId, after: auditView(p), meta }, session);
      return p;
    });
  } catch (err) {
    // Two sends of the same offline row race to the unique clientId index: the loser answers with the winner.
    if (isDuplicateKey(err)) return create(user, input, meta);
    throw err;
  }
  await ctx().bus.emit('prospect.created', { prospectId: idOf(doc), branchId, createdBy: user.id, fromProspectId });
  return { statusCode: 201, body: view(doc) };
}

/** Applies one change on the version that was read; a lost race is 409 INVALID_STATE PROSPECT_CHANGED (read again). */
async function write(user: AuthUser, p: Lean, update: Record<string, unknown>, action: string, reason: string | null, meta: RequestMeta): Promise<Lean> {
  const next = await withTransaction(async (session) => {
    const doc = (await ProspectModel.findOneAndUpdate({ _id: p._id, version: p.version }, { ...update, $inc: { version: 1 } }, { new: true, session }).lean()) as Lean | null;
    if (!doc) return null;
    await touch(doc, session);
    await audit.record({ actor: user, action, entity: 'prospect', entityId: idOf(doc), branchId: doc.branchId, before: auditView(p), after: auditView(doc), reason, meta }, session);
    return doc;
  });
  if (!next) throw invalidState('PROSPECT_CHANGED');
  return next;
}

const historyEntry = (status: ProspectStatus, at: Date, user: AuthUser, extra: { reason?: string | null; convertedCustomerId?: string | null; convertedErpCustomerId?: string | null } = {}) => ({
  status,
  at,
  by: person(user),
  reason: extra.reason ?? null,
  convertedCustomerId: extra.convertedCustomerId ?? null,
  convertedErpCustomerId: extra.convertedErpCustomerId ?? null,
});

function details(p: Lean): Details {
  const loc = p.location as Details['location'];
  return {
    name: p.name,
    phones: ((p.phones ?? []) as Phone[]).map((x) => ({ number: x.number, label: x.label ?? null })),
    address: p.address ?? null,
    note: p.note ?? null,
    location: loc ? { lat: loc.lat, lng: loc.lng, accuracyM: loc.accuracyM ?? null } : null,
  };
}

/** PATCH /prospects/{id} (prospect.manage): details and/or a status between new, contacted and dropped. */
export async function update(user: AuthUser, id: string, input: z.infer<typeof updateSchema>, meta: RequestMeta): Promise<ProspectView> {
  const p = await loadFor(manageFilter(user), id);
  const next: Partial<Details> = {};
  if (input.name !== undefined) next.name = input.name;
  if (input.phones !== undefined) next.phones = cleanPhones(input.phones);
  if (input.address !== undefined) next.address = input.address || null;
  if (input.note !== undefined) next.note = input.note || null;
  if (input.location !== undefined) next.location = cleanLocation(input.location);
  const set: Record<string, unknown> = { ...changedDetails(details(p), next) };
  const status = p.status as ProspectStatus;
  const moves = input.status !== undefined && input.status !== status;
  if (input.status !== undefined) {
    const rule = checkStatusChange(status, input.status);
    if (!rule.ok) throw invalidState(rule.reason, { status });
  }
  // Nothing new (a retry, or the same values again): no version bump, no audit line.
  if (!Object.keys(set).length && !moves) return view(p);
  const at = now();
  set.updatedAt = at;
  const upd: Record<string, unknown> = { $set: set };
  if (moves) {
    set.status = input.status;
    set.statusChangedAt = at;
    upd.$push = { history: historyEntry(input.status!, at, user, { reason: input.reason || null }) };
  }
  const doc = await write(user, p, upd, 'prospect.updated', input.reason || null, meta);
  await ctx().bus.emit('prospect.updated', { prospectId: id, branchId: doc.branchId, by: user.id, status: doc.status, statusChanged: moves });
  return view(doc);
}

/**
 * The FOS customer an ERP code names: the ERP id first, else an exact customer code among the caller's customers.
 * Only a customer in the caller's scope is linked (never leaks another branch's customer); otherwise the code is kept.
 */
async function resolveErpCode(user: AuthUser, code: string): Promise<CustomerRef | null> {
  const byId = await getByErpId(code);
  if (byId) return getCustomerRef(user, byId.id);
  for (const hit of await searchCustomers(user, code, 10)) {
    const ref = await getCustomerRef(user, hit.id);
    if (ref && ref.code.toLowerCase() === code.toLowerCase()) return ref;
  }
  return null;
}

/** POST /prospects/{id}/convert (prospect.manage). */
export async function convert(user: AuthUser, id: string, input: z.infer<typeof convertSchema>, meta: RequestMeta): Promise<ProspectView> {
  const p = await loadFor(manageFilter(user), id);
  const rule = checkConvert(p.status as ProspectStatus);
  if (!rule.ok) throw invalidState(rule.reason, { status: p.status });
  let customerId: string | null = null;
  let erpCode: string | null = null;
  if (input.customerId) {
    const c = await getCustomerRef(user, input.customerId);
    if (!c) throw notFound('customer'); // unknown or out of scope
    customerId = c.id;
    erpCode = c.code || input.erpCustomerCode || null;
  } else {
    erpCode = input.erpCustomerCode!;
    const c = await resolveErpCode(user, erpCode);
    if (c) {
      customerId = c.id;
      erpCode = c.code || erpCode;
    }
  }
  const at = now();
  const reason = input.note || null;
  const doc = await write(
    user,
    p,
    {
      $set: {
        status: 'converted',
        statusChangedAt: at,
        convertedCustomerId: customerId,
        convertedErpCustomerId: erpCode,
        convertedAt: at,
        convertedDate: businessDate(at),
        convertedBy: person(user),
        updatedAt: at,
      },
      $push: { history: historyEntry('converted', at, user, { reason, convertedCustomerId: customerId, convertedErpCustomerId: erpCode }) },
    },
    'prospect.converted',
    reason,
    meta,
  );
  await ctx().bus.emit('prospect.converted', { prospectId: id, branchId: doc.branchId, by: user.id, customerId, erpCustomerCode: erpCode });
  return view(doc);
}

/** POST /prospects/{id}/reopen (prospect.manage): back to `new`; the conversion link stays in history only. */
export async function reopen(user: AuthUser, id: string, reason: string, meta: RequestMeta): Promise<ProspectView> {
  const p = await loadFor(manageFilter(user), id);
  const rule = checkReopen(p.status as ProspectStatus);
  if (!rule.ok) throw invalidState(rule.reason, { status: p.status });
  const at = now();
  const doc = await write(
    user,
    p,
    {
      $set: { status: 'new', statusChangedAt: at, convertedCustomerId: null, convertedErpCustomerId: null, convertedAt: null, convertedDate: null, convertedBy: null, updatedAt: at },
      $push: { history: historyEntry('new', at, user, { reason }) },
    },
    'prospect.reopened',
    reason,
    meta,
  );
  await ctx().bus.emit('prospect.reopened', { prospectId: id, branchId: doc.branchId, by: user.id, from: p.status });
  return view(doc);
}

// ---------------- reads ----------------

export async function get(user: AuthUser, id: string): Promise<ProspectView> {
  return view(await loadFor(await itemFilter(user), id));
}

/** The list filter of GET /prospects, also used by the dashboard counters (same scope). */
async function listFilter(user: AuthUser, q: Omit<ListQuery, 'limit' | 'cursor'>): Promise<Record<string, unknown>> {
  const and: Record<string, unknown>[] = [await readFilter(user)];
  if (q.branchId) and.push(branchQuery(user, q.branchId));
  if (q.from || q.to) and.push({ createdDate: { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) } });
  if (q.status) and.push({ status: q.status });
  if (q.createdBy) and.push({ 'createdBy.id': q.createdBy });
  if (q.q) {
    const rx = { $regex: escapeRegex(q.q), $options: 'i' };
    const digits = phoneDigits(q.q);
    and.push({ $or: [{ name: rx }, { address: rx }, { note: rx }, ...(digits ? [{ 'phones.number': { $regex: escapeRegex(digits) } }] : [])] });
  }
  return { $and: and };
}

/** GET /prospects: newest first, paged by id, with the total of all pages. */
export async function list(user: AuthUser, q: ListQuery) {
  const f = await listFilter(user, q);
  const cur = decodeCursor<{ id: string }>(q.cursor);
  const [rows, total] = await Promise.all([
    ProspectModel.find({ ...f, ...(cur && isOid(cur.id) ? { _id: { $lt: cur.id } } : {}) })
      .sort({ _id: -1 })
      .limit(q.limit + 1)
      .lean() as Promise<Lean[]>,
    ProspectModel.countDocuments(f),
  ]);
  const items = rows.slice(0, q.limit);
  return { items: items.map(view), nextCursor: rows.length > q.limit ? encodeCursor({ id: idOf(items[items.length - 1]!) }) : null, total };
}

/**
 * Dashboard figures (contract 1.45.0 `prospectStats`), scoped like GET /prospects: created in [from, to] by Dhaka
 * creation date, converted in [from, to] by Dhaka conversion date, and open now (new or contacted).
 */
export async function dashboardStats(user: AuthUser, branchId: string | undefined, from: string, to: string): Promise<{ created: number; converted: number; openNow: number }> {
  const f = await listFilter(user, { ...(branchId ? { branchId } : {}) });
  const [created, converted, openNow] = await Promise.all([
    ProspectModel.countDocuments({ ...f, createdDate: { $gte: from, $lte: to } }),
    ProspectModel.countDocuments({ ...f, status: 'converted', convertedDate: { $gte: from, $lte: to } }),
    ProspectModel.countDocuments({ ...f, status: { $in: OPEN_STATUSES } }),
  ]);
  return { created, converted, openNow };
}

// ---------------- sync ----------------

/** Loader: what this user may read; anything else becomes a delete on the device. */
export async function syncLoad(ids: string[], user: AuthUser): Promise<Map<string, Record<string, unknown>>> {
  const rows = (await ProspectModel.find({ _id: { $in: ids.filter(isOid) }, ...(await itemFilter(user)) }).lean()) as Lean[];
  return new Map(rows.map((p) => [idOf(p), view(p)]));
}

/** Bootstrap: the user's own prospects of the last 90 Dhaka days, plus every one of theirs still open, paged by id. */
export async function snapshot(user: AuthUser, cursor: string | null, limit: number) {
  const cur = decodeCursor<{ id: string }>(cursor ?? undefined);
  const since = addDays(today(), -SNAPSHOT_DAYS);
  const rows = (await ProspectModel.find({
    'createdBy.id': user.id,
    $or: [{ status: { $in: OPEN_STATUSES } }, { createdDate: { $gte: since } }],
    ...(cur && isOid(cur.id) ? { _id: { $gt: cur.id } } : {}),
  })
    .sort({ _id: 1 })
    .limit(limit + 1)
    .lean()) as Lean[];
  const page = rows.slice(0, limit);
  return { items: page.map(view), nextCursor: rows.length > limit ? encodeCursor({ id: idOf(page[page.length - 1]!) }) : null };
}
