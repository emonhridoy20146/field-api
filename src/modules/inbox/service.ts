import { ctx } from '../../core/context/index.js';
import { AppError, notFound } from '../../core/errors/index.js';
import { isOid } from '../../core/db/index.js';
import { decodeCursor, encodeCursor } from '../../core/http/index.js';
import type { RequestMeta } from '../../core/http/router.js';
import type { I18n } from '../../core/module/types.js';
import { branchQuery, type AuthUser } from '../../core/security/types.js';
import * as audit from '../audit/index.js';
import { InboxItemModel } from './models/inbox.model.js';

type Lean = Record<string, any> & { _id: { toHexString(): string } };
const now = () => ctx().clock.now();
const RANK = { low: 0, medium: 1, high: 2, critical: 3 } as const;
export type Severity = keyof typeof RANK;

const view = (i: Lean) => ({
  id: i._id.toHexString(),
  type: i.type,
  severity: i.severity,
  branchId: i.branchId ?? '',
  entity: i.entity,
  entityId: i.entityId,
  summary: i.summary,
  status: i.status,
  createdAt: (i.createdAt as Date).toISOString(),
  ...(i.link ? { link: i.link } : {}),
  ...(i.snoozedUntil ? { snoozedUntil: (i.snoozedUntil as Date).toISOString() } : {}),
  ...(i.resolvedAt ? { resolvedAt: (i.resolvedAt as Date).toISOString(), resolvedBy: i.resolvedBy } : {}),
});

export function severityOf(type: string, fallback: Severity = 'medium'): Severity {
  for (const m of ctx().manifests) for (const t of m.inboxTypes ?? []) if (t.type === type) return t.severity;
  return fallback;
}

export interface RaiseInput {
  key: string;
  type: string;
  branchId: string | null;
  entity: string;
  entityId: string;
  summary: I18n;
  link?: string;
  delayMs?: number;
}

/** Create the item once per key; a resolved item with the same key is reopened (the problem came back). */
export async function raise(input: RaiseInput): Promise<void> {
  const at = now();
  const severity = severityOf(input.type);
  await InboxItemModel.updateOne(
    { key: input.key },
    {
      $set: { type: input.type, severity, severityRank: RANK[severity], branchId: input.branchId, entity: input.entity, entityId: input.entityId, summary: input.summary, link: input.link ?? null, status: 'open', snoozedUntil: null, resolvedBy: null, resolvedAt: null, resolveReason: null },
      $setOnInsert: { createdAt: at, visibleFrom: new Date(at.getTime() + (input.delayMs ?? 0)) },
    },
    { upsert: true },
  );
}

/** The underlying problem went away by itself (e.g. conflict resolved, deposit verified). */
export async function autoResolve(key: string): Promise<void> {
  await InboxItemModel.updateOne({ key, status: { $ne: 'resolved' } }, { $set: { status: 'resolved', resolvedBy: 'system', resolvedAt: now() } });
}

async function wakeSnoozed(): Promise<void> {
  await InboxItemModel.updateMany({ status: 'snoozed', snoozedUntil: { $lte: now() } }, { $set: { status: 'open', snoozedUntil: null } });
}

export async function list(user: AuthUser, q: { branchId?: string | undefined; status: 'open' | 'snoozed' | 'resolved'; type?: string | undefined; limit: number; cursor?: string | undefined }) {
  await wakeSnoozed();
  // Items without a branch (system-wide) are for super admins only, which branchQuery already implies.
  const scope = { ...branchQuery(user, q.branchId), visibleFrom: { $lte: now() } };
  const cur = decodeCursor<{ r: number; id: string }>(q.cursor);
  const f: Record<string, unknown> = { ...scope, status: q.status, ...(q.type ? { type: q.type } : {}) };
  if (cur) f.$or = [{ severityRank: { $lt: cur.r } }, { severityRank: cur.r, _id: { $lt: cur.id } }];
  const rows = (await InboxItemModel.find(f).sort({ severityRank: -1, _id: -1 }).limit(q.limit + 1).lean()) as Lean[];
  const items = rows.slice(0, q.limit);
  const last = items[items.length - 1];
  const grouped = await InboxItemModel.aggregate<{ _id: string; n: number }>([{ $match: { ...scope, status: 'open' } }, { $group: { _id: '$type', n: { $sum: 1 } } }]);
  return { items: items.map(view), counts: Object.fromEntries(grouped.map((g) => [g._id, g.n])), nextCursor: rows.length > q.limit && last ? encodeCursor({ r: last.severityRank, id: last._id.toHexString() }) : null };
}

async function load(user: AuthUser, id: string): Promise<Lean> {
  const i = isOid(id) ? ((await InboxItemModel.findOne({ _id: id, ...branchQuery(user, undefined) }).lean()) as Lean | null) : null;
  if (!i) throw notFound('inbox_item');
  return i;
}

export async function resolve(user: AuthUser, id: string, reason: string | null, meta: RequestMeta) {
  const i = await load(user, id);
  if (i.status === 'resolved') return view(i);
  await InboxItemModel.updateOne({ _id: i._id }, { $set: { status: 'resolved', resolvedBy: user.id, resolvedAt: now(), resolveReason: reason, snoozedUntil: null } });
  await audit.record({ actor: user, action: 'inbox.resolved', entity: 'inbox_item', entityId: id, branchId: i.branchId, after: { type: i.type, key: i.key }, reason, meta });
  return view((await InboxItemModel.findById(i._id).lean()) as Lean);
}

export async function snooze(user: AuthUser, id: string, until: Date) {
  const i = await load(user, id);
  if (i.status === 'resolved') throw new AppError('INVALID_STATE', { reason: 'ALREADY_RESOLVED' });
  const max = new Date(now().getTime() + 30 * 86_400_000);
  if (until <= now() || until > max) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'until', message: 'must be in the future, at most 30 days' }] });
  await InboxItemModel.updateOne({ _id: i._id }, { $set: { status: 'snoozed', snoozedUntil: until } });
  return view((await InboxItemModel.findById(i._id).lean()) as Lean);
}

/** Open, visible item counts per type for a branch filter (dashboard "exceptions"). */
export async function openCounts(user: AuthUser, branchId?: string): Promise<Record<string, number>> {
  await wakeSnoozed();
  const grouped = await InboxItemModel.aggregate<{ _id: string; n: number }>([{ $match: { ...branchQuery(user, branchId), status: 'open', visibleFrom: { $lte: now() } } }, { $group: { _id: '$type', n: { $sum: 1 } } }]);
  return Object.fromEntries(grouped.map((g) => [g._id, g.n]));
}
