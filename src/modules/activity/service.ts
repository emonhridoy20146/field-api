import { z } from 'zod';
import { ctx } from '../../core/context/index.js';
import { type LeanDoc } from '../../core/db/index.js';
import { decodeCursor, encodeCursor } from '../../core/http/index.js';
import { branchQuery, type AuthUser } from '../../core/security/types.js';
import { getUsers } from '../users/index.js';
import { getCustomerRefs } from '../customers/index.js';
import { ACTIVITY_TYPES, FROM_EVENT, UNSEEN_CAP, type ActivityDraft } from './domain/feed.js';
import { ActivityItemModel, ActivitySeenModel } from './models/activity.model.js';

type Lean = LeanDoc;
const now = () => ctx().clock.now();

/** Write one line; the same event delivered again changes nothing. */
export async function add(d: ActivityDraft): Promise<void> {
  await ActivityItemModel.updateOne({ key: d.key }, { $setOnInsert: { ...d, at: now() } }, { upsert: true });
}

/** FR-ACT-001: the feed is fed by domain events only; no module writes to it directly. */
export function subscribe(): void {
  const bus = ctx().bus;
  for (const [event, toDraft] of Object.entries(FROM_EVENT))
    bus.on(event, async (payload) => {
      const d = toDraft(payload as Record<string, unknown>);
      if (d) await add(d);
    });
}

export const listQuery = z.object({
  branchId: z.string().max(64).optional(),
  type: z.enum(ACTIVITY_TYPES).optional(),
  userId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(200).optional(),
});

async function seenAt(userId: string): Promise<Date | null> {
  const s = (await ActivitySeenModel.findOne({ userId }).lean()) as { at: Date } | null;
  return s?.at ?? null;
}

/**
 * The newest staff activity in the caller's branch scope, with the person and the customer named. `unseen` counts
 * what arrived since the caller last marked the feed as seen (capped), whatever the filters.
 */
export async function list(user: AuthUser, q: z.infer<typeof listQuery>) {
  const scope = branchQuery(user, q.branchId);
  const cur = decodeCursor<{ id: string }>(q.cursor);
  const f: Record<string, unknown> = { ...scope, ...(q.type ? { type: q.type } : {}), ...(q.userId ? { actorId: q.userId } : {}), ...(cur ? { _id: { $lt: cur.id } } : {}) };
  const rows = (await ActivityItemModel.find(f).sort({ _id: -1 }).limit(q.limit + 1).lean()) as Lean[];
  const items = rows.slice(0, q.limit);
  const last = items[items.length - 1];
  const users = await getUsers([...new Set(items.flatMap((i) => [i.actorId as string | null, i.byId as string | null]).filter((x): x is string => !!x))]);
  const refs = await getCustomerRefs([...new Set(items.map((i) => i.customerId as string | null).filter((x): x is string => !!x))]);
  const seen = await seenAt(user.id);
  const unseen = await ActivityItemModel.countDocuments({ ...branchQuery(user, undefined), ...(seen ? { at: { $gt: seen } } : {}) }, { limit: UNSEEN_CAP });
  return {
    items: items.map((i) => {
      const u = i.actorId ? users.get(i.actorId as string) : undefined;
      const c = i.customerId ? refs.get(i.customerId as string) : undefined;
      return {
        id: i._id.toHexString() as string,
        type: i.type as string,
        at: (i.at as Date).toISOString(),
        branchId: (i.branchId as string | null) ?? null,
        actor: i.actorId ? { id: i.actorId as string, name: u?.name ?? { bn: '', en: '' }, employeeCode: u?.employeeCode ?? '' } : null,
        by: i.byId ? { id: i.byId as string, name: users.get(i.byId as string)?.name ?? { bn: '', en: '' }, employeeCode: users.get(i.byId as string)?.employeeCode ?? '' } : null,
        customer: i.customerId ? { id: i.customerId as string, name: c?.name ?? { bn: '', en: '' }, code: c?.code ?? '' } : null,
        entity: i.entity as string,
        entityId: i.entityId as string,
        data: (i.data ?? {}) as Record<string, unknown>,
        unseen: !seen || (i.at as Date) > seen,
      };
    }),
    unseen,
    seenAt: seen ? seen.toISOString() : null,
    nextCursor: rows.length > q.limit && last ? encodeCursor({ id: last._id.toHexString() }) : null,
  };
}

/** The caller has looked at the feed: the bell's count starts again from now. */
export async function markSeen(user: AuthUser) {
  const at = now();
  await ActivitySeenModel.updateOne({ userId: user.id }, { $set: { at } }, { upsert: true });
  return { seenAt: at.toISOString(), unseen: 0 };
}
