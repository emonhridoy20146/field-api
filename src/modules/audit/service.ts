import { Schema, model, type ClientSession } from 'mongoose';
import { createHash } from 'node:crypto';
import { ctx } from '../../core/context/index.js';
import { canonicalJson } from '../../core/idempotency/index.js';
import { decodeCursor, encodeCursor } from '../../core/http/index.js';
import { branchQuery, type AuthUser } from '../../core/security/types.js';
import { AuditLogModel } from './models/audit-log.model.js';

const headSchema = new Schema({ _id: String, seq: Number, hash: String }, { collection: 'audit_head', versionKey: false });
const AuditHeadModel = model('AuditHead', headSchema);

const GENESIS = 'genesis';

export interface AuditActor {
  id: string | null;
  role: string | null;
  name?: string | null;
}

export interface AuditEntryInput {
  actor: AuditActor | AuthUser | null;
  action: string;
  entity: string;
  entityId?: string | null;
  branchId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  meta?: { ip?: string | null; deviceId?: string | null; requestId?: string | null; userAgent?: string | null };
  money?: boolean;
}

function actorFields(a: AuditEntryInput['actor']) {
  if (!a) return { actorId: null, actorRole: 'system', actorName: 'system' };
  const name = 'name' in a && a.name && typeof a.name === 'object' ? (a.name.en ?? a.name.bn ?? null) : ((a as AuditActor).name ?? null);
  return { actorId: a.id, actorRole: a.role, actorName: name };
}

export function computeHash(prevHash: string, body: Record<string, unknown>): string {
  return createHash('sha256').update(prevHash).update(canonicalJson(body)).digest('hex');
}

/**
 * Append an audit entry with a hash chain (ADR-023). Pass the caller's session so the entry
 * commits atomically with the change it describes.
 */
export async function record(entry: AuditEntryInput, session?: ClientSession): Promise<void> {
  const base = {
    at: ctx().clock.now(),
    ...actorFields(entry.actor),
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    branchId: entry.branchId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    reason: entry.reason ?? null,
    ip: entry.meta?.ip ?? null,
    deviceId: entry.meta?.deviceId ?? null,
    userAgent: entry.meta?.userAgent ?? null,
    requestId: entry.meta?.requestId ?? null,
    money: entry.money ?? false,
  };
  for (let attempt = 0; attempt < 20; attempt++) {
    const head = (await AuditHeadModel.findById('head').session(session ?? null).lean()) ?? { seq: 0, hash: GENESIS };
    const seq = (head.seq ?? 0) + 1;
    const prevHash = head.hash ?? GENESIS;
    const doc = { ...base, seq, prevHash };
    const hash = computeHash(prevHash, JSON.parse(JSON.stringify(doc)) as Record<string, unknown>);
    const res = await AuditHeadModel.updateOne(
      head.seq ? { _id: 'head', seq: head.seq } : { _id: 'head', seq: { $exists: false } },
      { $set: { seq, hash } },
      { upsert: !head.seq, session },
    ).catch((e: unknown) => {
      if ((e as { code?: number }).code === 11000) return { modifiedCount: 0, upsertedCount: 0 };
      throw e;
    });
    if (res.modifiedCount === 0 && res.upsertedCount === 0) continue; // lost the race; retry
    await AuditLogModel.create([{ ...doc, hash }], { session });
    return;
  }
  throw new Error('audit: could not append after retries');
}

/** Verify the hash chain (restore drill, FR-AUD-004). Returns first broken seq or null. */
export async function verifyChain(): Promise<{ ok: boolean; checked: number; brokenAt: number | null }> {
  let prev = GENESIS;
  let checked = 0;
  for await (const d of AuditLogModel.find().sort({ seq: 1 }).lean().cursor()) {
    const { _id, hash, ...rest } = d as unknown as Record<string, unknown> & { hash: string };
    void _id;
    const body = JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
    if (rest.prevHash !== prev || computeHash(prev, body) !== hash) return { ok: false, checked, brokenAt: rest.seq as number };
    prev = hash;
    checked++;
  }
  return { ok: true, checked, brokenAt: null };
}

export interface AuditQuery {
  branchId?: string;
  actorId?: string;
  action?: string;
  entity?: string;
  entityId?: string;
  from?: string;
  to?: string;
  limit: number;
  cursor?: string;
}

export async function list(user: AuthUser, q: AuditQuery) {
  const filter: Record<string, unknown> = {};
  if (user.role !== 'super_admin') Object.assign(filter, branchQuery(user, q.branchId));
  else if (q.branchId) filter.branchId = q.branchId;
  if (q.actorId) filter.actorId = q.actorId;
  if (q.action) filter.action = q.action.endsWith('*') ? { $regex: `^${q.action.slice(0, -1).replace(/[.]/g, '\\.')}` } : q.action;
  if (q.entity) filter.entity = q.entity;
  if (q.entityId) filter.entityId = q.entityId;
  if (q.from || q.to) filter.at = { ...(q.from ? { $gte: new Date(q.from) } : {}), ...(q.to ? { $lte: new Date(q.to) } : {}) };
  const c = decodeCursor<{ seq: number }>(q.cursor);
  if (c) filter.seq = { $lt: c.seq };
  const rows = await AuditLogModel.find(filter).sort({ seq: -1 }).limit(q.limit + 1).lean();
  const page = rows.slice(0, q.limit);
  return {
    items: page.map((r) => ({
      id: r._id.toHexString(),
      at: r.at.toISOString(),
      actor: { id: r.actorId ?? '', name: r.actorName ?? '', role: r.actorRole ?? '' },
      action: r.action,
      entity: r.entity,
      entityId: r.entityId ?? '',
      branchId: r.branchId ?? '',
      before: (r.before as Record<string, unknown> | null) ?? {},
      after: (r.after as Record<string, unknown> | null) ?? {},
      reason: r.reason ?? '',
      ip: r.ip ?? '',
      deviceId: r.deviceId ?? '',
      requestId: r.requestId ?? '',
    })),
    nextCursor: rows.length > q.limit ? encodeCursor({ seq: page[page.length - 1]!.seq }) : null,
  };
}
