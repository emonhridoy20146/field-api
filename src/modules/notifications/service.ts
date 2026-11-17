import { z } from 'zod';
import { ctx } from '../../core/context/index.js';
import { AppError, notFound } from '../../core/errors/index.js';
import { isOid, type LeanDoc } from '../../core/db/index.js';
import { recordChanges } from '../../core/changefeed/index.js';
import { decodeCursor, encodeCursor } from '../../core/http/index.js';
import type { RequestMeta } from '../../core/http/router.js';
import type { I18n } from '../../core/module/types.js';
import { dhakaMinuteOfDay } from '../../core/time/index.js';
import { canSeeBranch, isSuperAdmin, type AuthUser, type Role } from '../../core/security/types.js';
import * as audit from '../audit/index.js';
import { getSetting } from '../settings/index.js';
import { getUsers, listByRole } from '../users/index.js';
import { dropPushToken, pushTokensFor } from '../devices/index.js';
import { shouldPush, type QuietHours } from './domain/quiet-hours.js';
import { BroadcastModel, NotificationModel } from './models/notification.model.js';
import { pushSender } from './push.js';

type Lean = LeanDoc;
const now = () => ctx().clock.now();

const view = (n: Lean) => ({
  id: n._id.toHexString(),
  type: n.type,
  title: n.title,
  body: n.body,
  data: n.data ?? {},
  read: !!n.readAt,
  ...(n.readAt ? { readAt: (n.readAt as Date).toISOString() } : {}),
  createdAt: (n.createdAt as Date).toISOString(),
});

function isCritical(type: string): boolean {
  for (const m of ctx().manifests) for (const t of m.notificationTypes ?? []) if (t.type === type) return !!t.critical;
  return false;
}

export interface NotifyInput {
  userIds: string[];
  type: string;
  title: I18n;
  body: I18n;
  /** Small routing payload for the app (ids only — no money totals, no phone numbers). */
  data?: Record<string, string>;
}

/**
 * Store one notification per recipient (FR-NOT-003), feed it to mobile sync, then push (FR-NOT-001).
 * Inside quiet hours only critical types are pushed; the stored item is still there in the morning.
 */
export async function notify(input: NotifyInput): Promise<number> {
  const userIds = [...new Set(input.userIds.filter(Boolean))];
  if (!userIds.length) return 0;
  const at = now();
  const docs = await NotificationModel.insertMany(userIds.map((userId) => ({ userId, type: input.type, title: input.title, body: input.body, data: input.data ?? {}, createdAt: at })));
  await recordChanges(docs.map((d) => ({ entity: 'notification', entityId: d._id.toHexString(), userIds: [d.userId] })));

  const quiet = (await getSetting<QuietHours>('notifications.quietHours')) ?? { start: '21:00', end: '08:00' };
  if (!shouldPush(dhakaMinuteOfDay(at), quiet, isCritical(input.type))) return userIds.length;
  try {
    const tokens = await pushTokensFor(userIds);
    if (tokens.length) {
      const users = await getUsers(userIds);
      // One send per language so each device gets its user's language.
      for (const lang of ['bn', 'en'] as const) {
        const batch = tokens.filter((t) => (users.get(t.userId)?.locale ?? 'bn') === lang).map((t) => t.token);
        if (!batch.length) continue;
        const res = await pushSender().send(batch, { type: input.type, title: input.title[lang], body: input.body[lang], data: input.data ?? {} });
        for (const bad of res.invalidTokens) await dropPushToken(bad);
      }
      await NotificationModel.updateMany({ _id: { $in: docs.map((d) => d._id) } }, { $set: { pushed: true } });
    }
  } catch (err) {
    // Push is best effort: the notification is stored and reaches the app through sync.
    ctx().logger.warn({ err, type: input.type }, 'push failed');
  }
  return userIds.length;
}

// ---------------- center (self-service) ----------------

export async function list(user: AuthUser, q: { limit: number; cursor?: string | undefined; unread?: boolean | undefined }) {
  const cur = decodeCursor<{ id: string }>(q.cursor);
  const f: Record<string, unknown> = { userId: user.id, ...(q.unread ? { readAt: null } : {}), ...(cur ? { _id: { $lt: cur.id } } : {}) };
  const rows = (await NotificationModel.find(f).sort({ _id: -1 }).limit(q.limit + 1).lean()) as Lean[];
  const items = rows.slice(0, q.limit);
  return {
    items: items.map(view),
    nextCursor: rows.length > q.limit ? encodeCursor({ id: items[items.length - 1]!._id.toHexString() }) : null,
    unreadCount: await NotificationModel.countDocuments({ userId: user.id, readAt: null }),
  };
}

export async function get(user: AuthUser, id: string) {
  const n = isOid(id) ? ((await NotificationModel.findOne({ _id: id, userId: user.id }).lean()) as Lean | null) : null;
  if (!n) throw notFound('notification');
  return view(n);
}

export async function markRead(user: AuthUser, id: string): Promise<void> {
  if (!isOid(id)) throw notFound('notification');
  const r = await NotificationModel.updateOne({ _id: id, userId: user.id }, [{ $set: { readAt: { $ifNull: ['$readAt', now()] } } }]);
  if (r.matchedCount !== 1) throw notFound('notification');
}

export async function markAllRead(user: AuthUser): Promise<void> {
  await NotificationModel.updateMany({ userId: user.id, readAt: null }, { $set: { readAt: now() } });
}

// ---------------- broadcasts (FR-NOT-005) ----------------

const i18n = z.object({ bn: z.string().trim().min(1).max(500), en: z.string().trim().max(500).default('') });
export const broadcastSchema = z.object({
  branchIds: z.array(z.string().max(64)).max(100).optional(),
  roles: z.array(z.enum(['super_admin', 'branch_manager', 'field_staff', 'viewer'])).max(4).optional(),
  title: i18n,
  body: i18n.extend({ bn: z.string().trim().min(1).max(2000), en: z.string().trim().max(2000).default('') }),
  requireAck: z.boolean().default(false),
});

const text = (t: { bn: string; en: string }): I18n => ({ bn: t.bn, en: t.en || t.bn });

function broadcastView(b: Lean, viewer: AuthUser, names: Map<string, { name: { en?: string; bn?: string } }>) {
  const by = names.get(b.createdBy);
  return {
    id: b._id.toHexString(),
    title: b.title,
    body: b.body,
    branchIds: b.branchIds,
    roles: b.roles,
    requireAck: b.requireAck,
    createdBy: { id: b.createdBy, name: by ? by.name.en || by.name.bn || '' : '' },
    createdAt: (b.createdAt as Date).toISOString(),
    recipientCount: (b.recipientIds as string[]).length,
    ackCount: (b.ackedBy as string[]).length,
    acked: (b.ackedBy as string[]).includes(viewer.id),
    ...ackedAtOf(b, viewer.id),
  };
}

function ackedAtOf(b: Lean, userId: string): { ackedAt?: string } {
  const a = ((b.acks ?? []) as { userId: string; at: Date }[]).find((x) => x.userId === userId);
  return a ? { ackedAt: a.at.toISOString() } : {};
}

export async function createBroadcast(actor: AuthUser, input: z.infer<typeof broadcastSchema>, meta: RequestMeta) {
  // Target branches: asked ones must be visible; default is everything the sender can see.
  const asked = input.branchIds?.length ? input.branchIds : null;
  if (asked && !asked.every((b) => canSeeBranch(actor, b))) throw notFound('branch');
  const branchIds = asked ?? (isSuperAdmin(actor) ? null : actor.branchIds);
  const roles = (input.roles?.length ? input.roles : ['field_staff']) as Role[];
  const recipients = (await listByRole(roles, branchIds ?? undefined)).map((u) => u.id).filter((id) => id !== actor.id);
  if (!recipients.length) throw new AppError('BUSINESS_RULE', { rule: 'NO_RECIPIENTS' });
  const title = text(input.title);
  const body = text(input.body);
  const b = await BroadcastModel.create({ title, body, branchIds: branchIds ?? [], roles, requireAck: input.requireAck, createdBy: actor.id, createdAt: now(), recipientIds: recipients });
  const id = b._id.toHexString();
  await audit.record({ actor, action: 'broadcast.sent', entity: 'broadcast', entityId: id, after: { recipients: recipients.length, roles, requireAck: input.requireAck }, meta });
  await recordChanges(recipients.map((userId) => ({ entity: 'broadcast', entityId: id, userIds: [userId] })));
  await notify({ userIds: recipients, type: 'announcement', title, body, data: { broadcastId: id, requireAck: String(input.requireAck) } });
  return broadcastView(b.toObject() as Lean, actor, await getUsers([actor.id]));
}

/** Senders see what they can manage; everyone else sees broadcasts addressed to them. */
export async function listBroadcasts(user: AuthUser, canSend: boolean, q: { limit: number; cursor?: string | undefined }) {
  const cur = decodeCursor<{ id: string }>(q.cursor);
  const scope = canSend ? (isSuperAdmin(user) ? {} : { $or: [{ createdBy: user.id }, { branchIds: { $in: user.branchIds } }, { recipientIds: user.id }] }) : { recipientIds: user.id };
  const rows = (await BroadcastModel.find({ ...scope, ...(cur ? { _id: { $lt: cur.id } } : {}) }).sort({ _id: -1 }).limit(q.limit + 1).lean()) as Lean[];
  const items = rows.slice(0, q.limit);
  const names = await getUsers(items.map((b) => b.createdBy));
  return { items: items.map((b) => broadcastView(b, user, names)), nextCursor: rows.length > q.limit ? encodeCursor({ id: items[items.length - 1]!._id.toHexString() }) : null };
}

export async function getBroadcastFor(user: AuthUser, id: string) {
  const b = isOid(id) ? ((await BroadcastModel.findOne({ _id: id, recipientIds: user.id }).lean()) as Lean | null) : null;
  if (!b) throw notFound('broadcast');
  return broadcastView(b, user, await getUsers([b.createdBy]));
}

/**
 * The recipient read it (FR-NOT-005). Idempotent; the first time counts. `at` is when the phone
 * recorded the tap (offline acks arrive later through sync); it is kept between sending and now.
 */
export async function ack(user: AuthUser, id: string, at?: Date): Promise<void> {
  if (!isOid(id)) throw notFound('broadcast');
  const b = (await BroadcastModel.findOne({ _id: id, recipientIds: user.id }, { createdAt: 1, ackedBy: 1 }).lean()) as Lean | null;
  if (!b) throw notFound('broadcast');
  if ((b.ackedBy as string[]).includes(user.id)) return;
  const nowAt = now();
  const created = b.createdAt as Date;
  const when = at && at.getTime() >= created.getTime() && at.getTime() <= nowAt.getTime() ? at : nowAt;
  const r = await BroadcastModel.updateOne({ _id: id, recipientIds: user.id, ackedBy: { $ne: user.id } }, { $addToSet: { ackedBy: user.id }, $push: { acks: { userId: user.id, at: when } } });
  // The phone's copy follows (acked = true) on its next pull.
  if (r.modifiedCount === 1) await recordChanges([{ entity: 'broadcast', entityId: id, userIds: [user.id] }]);
}

/** Who got a broadcast and who has read it (1.12.0). Same scope as the sender's list; else 404. */
export async function recipients(user: AuthUser, id: string) {
  const scope = isSuperAdmin(user) ? {} : { $or: [{ createdBy: user.id }, { branchIds: { $in: user.branchIds } }] };
  const b = isOid(id) ? ((await BroadcastModel.findOne({ _id: id, ...scope }).lean()) as Lean | null) : null;
  if (!b) throw notFound('broadcast');
  const ids = b.recipientIds as string[];
  const users = await getUsers(ids);
  const acks = new Map(((b.acks ?? []) as { userId: string; at: Date }[]).map((a) => [a.userId, a.at]));
  const acked = new Set(b.ackedBy as string[]);
  const items = ids.map((uid) => {
    const u = users.get(uid);
    const at = acks.get(uid);
    return {
      userId: uid,
      name: u ? { bn: u.name.bn, en: u.name.en } : { bn: '', en: '' },
      employeeCode: u?.employeeCode ?? '',
      branchId: u?.branchIds[0] ?? null,
      role: u?.role ?? 'field_staff',
      acked: acked.has(uid),
      ...(at ? { ackedAt: at.toISOString() } : {}),
    };
  });
  // Not read first, so the manager sees whom to chase.
  items.sort((a, b2) => Number(a.acked) - Number(b2.acked) || (a.name.en || a.name.bn).localeCompare(b2.name.en || b2.name.bn));
  return { broadcastId: id, recipientCount: ids.length, ackCount: acked.size, items };
}
