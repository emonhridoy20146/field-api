import { z } from 'zod';
import { ctx } from '../../core/context/index.js';
import { AppError, toProblem } from '../../core/errors/index.js';
import { ChangeModel, currentSeq } from '../../core/changefeed/index.js';
import { withIdempotency, payloadHash } from '../../core/idempotency/index.js';
import { decodeCursor, encodeCursor } from '../../core/http/index.js';
import type { RequestMeta } from '../../core/http/router.js';
import type { ModuleManifest, SyncEntityDef, SyncMutationDef, SyncMutationResult } from '../../core/module/types.js';
import { branchQuery, type AuthUser } from '../../core/security/types.js';
import { can, effectivePermissions, permissionsVersion } from '../rbac/index.js';
import { flagsFor, isEnabledForUser } from '../flags/index.js';
import { appSettings } from '../settings/index.js';
import { cashPositionOf } from '../cash/index.js';
import { myTarget } from '../targets/index.js';
import { getUsers } from '../users/index.js';
import { DeviceSyncStateModel } from './models/sync.model.js';

const now = () => ctx().clock.now();
const cursorOf = (seq: number) => `s_${seq}`;

function parseCursor(raw: string): number {
  const m = /^s_(\d{1,15})$/.exec(raw);
  if (!m) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'cursor', message: 'expected s_<number>' }] });
  return Number(m[1]);
}

/** Registries built from the manifests of enabled-by-flag modules, checked per call. */
function owners<T extends { entity: string }>(pick: (m: ModuleManifest) => T[] | undefined): Map<string, { def: T; manifest: ModuleManifest }> {
  const out = new Map<string, { def: T; manifest: ModuleManifest }>();
  for (const m of ctx().manifests) for (const def of pick(m) ?? []) out.set(def.entity, { def, manifest: m });
  return out;
}
const moduleOn = async (m: ModuleManifest, user: AuthUser) => !m.featureFlag || (await isEnabledForUser(m.featureFlag.key, user));

async function touchState(user: AuthUser, set: Record<string, unknown>) {
  if (!user.deviceId) return;
  await DeviceSyncStateModel.updateOne({ deviceId: user.deviceId, userId: user.id }, { $set: { branchId: user.branchIds[0] ?? null, ...set } }, { upsert: true });
}

/** Things every sync response carries so the app converges without extra calls (FR-SYNC-001/004). */
async function envelope(user: AuthUser) {
  const flags = await flagsFor(user);
  const cash = user.role === 'field_staff' && flags['module.cash'] ? await cashPositionOf(user.id).catch(() => undefined) : undefined;
  // FR-COL-015: the Today card works offline from this; progress is counted on the device.
  const target = user.role === 'field_staff' && flags['module.targets'] ? await myTarget(user).catch(() => undefined) : undefined;
  return {
    permissions: { version: await permissionsVersion(), keys: [...(await effectivePermissions(user))].sort() },
    flags,
    settings: await appSettings(user.branchIds[0] ?? null),
    ...(cash ? { cash } : {}),
    ...(target ? { target } : {}),
    serverTime: now().toISOString(),
  };
}

// ---------------- pull (FR-SYNC-001) ----------------

export async function pull(user: AuthUser, q: { cursor: string; limit: number }) {
  const since = parseCursor(q.cursor);
  const head = await currentSeq();
  // A cursor ahead of the feed (database restored) or behind the retained window (30-day TTL) cannot be continued.
  const oldest = await ChangeModel.findOne().sort({ seq: 1 }).select({ seq: 1 }).lean();
  if (since > head || (since < head && (!oldest || since + 1 < oldest.seq))) throw new AppError('CURSOR_EXPIRED');

  // Own changes, plus branch-wide ones of the user's branches (ADR-037); each loader still applies the user's scope.
  const audience = user.branchIds.length ? { $or: [{ userIds: user.id }, { fanoutBranchId: { $in: user.branchIds } }] } : { userIds: user.id };
  const rows = await ChangeModel.find({ ...audience, seq: { $gt: since } }).sort({ seq: 1 }).limit(q.limit + 1).lean();
  const page = rows.slice(0, q.limit);
  const hasMore = rows.length > q.limit;
  // Only the newest change per entity matters; data is loaded fresh, so older entries are redundant.
  const latest = new Map<string, (typeof page)[number]>();
  for (const r of page) latest.set(`${r.entity}:${r.entityId}`, r);

  const loaders = owners<SyncEntityDef>((m) => m.syncEntities);
  const byEntity = new Map<string, string[]>();
  for (const r of latest.values()) if (r.op === 'upsert') byEntity.set(r.entity, [...(byEntity.get(r.entity) ?? []), r.entityId]);
  const loaded = new Map<string, Map<string, Record<string, unknown>>>();
  for (const [entity, ids] of byEntity) {
    const o = loaders.get(entity);
    if (o && (await moduleOn(o.manifest, user))) loaded.set(entity, await o.def.load(ids, user));
  }

  const changes = [...latest.values()]
    .sort((a, b) => a.seq - b.seq)
    .map((r) => {
      const data = r.op === 'upsert' ? loaded.get(r.entity)?.get(r.entityId) : undefined;
      // Not loadable any more (left the scope, module off) → tombstone so the device drops it.
      if (!data) return { seq: r.seq, entity: r.entity, op: 'delete' as const, id: r.entityId, reason: r.reason ?? (r.op === 'delete' ? 'removed' : 'out_of_scope') };
      return { seq: r.seq, entity: r.entity, op: 'upsert' as const, id: r.entityId, data };
    });

  // When the page is the tail, jump to the feed head so other users' changes are not rescanned.
  const next = hasMore ? page[page.length - 1]!.seq : head;
  await touchState(user, { lastPullSeq: next, lastPullAt: now() });
  return { changes, nextCursor: cursorOf(next), hasMore, ...(await envelope(user)) };
}

// ---------------- bootstrap (FR-SYNC-006) ----------------

interface BootCursor extends Record<string, unknown> {
  i: number; // index into the snapshot-capable entities
  c: string | null; // that entity's own cursor
  seq: number; // feed head captured on the first page → pull cursor after the snapshot
}

export async function bootstrap(user: AuthUser, q: { cursor?: string | undefined; limit: number }) {
  const snaps: { def: SyncEntityDef; manifest: ModuleManifest }[] = [];
  for (const o of owners<SyncEntityDef>((m) => m.syncEntities).values()) if (o.def.snapshot && (await moduleOn(o.manifest, user))) snaps.push(o);
  snaps.sort((a, b) => a.def.entity.localeCompare(b.def.entity));
  let cur = decodeCursor<BootCursor>(q.cursor) ?? { i: 0, c: null, seq: await currentSeq() };
  if (!Number.isInteger(cur.i) || cur.i < 0 || !Number.isInteger(cur.seq)) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'cursor', message: 'invalid' }] });

  const items: { entity: string; op: 'upsert'; id: string; data: Record<string, unknown> }[] = [];
  let next: BootCursor | null = cur;
  while (next && items.length < q.limit) {
    const s: (typeof snaps)[number] | undefined = snaps[next.i];
    if (!s) {
      next = null;
      break;
    }
    const page: { items: Record<string, unknown>[]; nextCursor: string | null } = await s.def.snapshot!(user, next.c, q.limit - items.length);
    for (const d of page.items) items.push({ entity: s.def.entity, op: 'upsert', id: String(d.id), data: d });
    cur = next;
    next = page.nextCursor ? { ...cur, c: page.nextCursor } : cur.i + 1 < snaps.length ? { i: cur.i + 1, c: null, seq: cur.seq } : null;
  }
  const done = next === null;
  if (done) await touchState(user, { lastPullSeq: cur.seq, lastPullAt: now() });
  return { items, nextCursor: next ? encodeCursor(next) : null, ...(done ? { pullCursor: cursorOf(cur.seq) } : {}), ...(await envelope(user)) };
}

// ---------------- push (FR-SYNC-002) ----------------

export const pushSchema = z.object({
  deviceId: z.string().max(100),
  lastPullCursor: z.string().max(40).optional(),
  pendingCount: z.number().int().min(0).max(100_000).optional(),
  mutations: z
    .array(z.object({ mutationId: z.string().uuid(), entity: z.string().max(40), op: z.enum(['create', 'update']), payload: z.record(z.unknown()), createdAt: z.string().datetime({ offset: true }).optional() }))
    .max(100),
});

type PushResult = { mutationId: string; result: 'applied' | 'replayed' | 'conflict' | 'rejected'; entityId?: string; status?: string; conflict?: SyncMutationResult['conflict']; error?: unknown } & Record<string, unknown>;

/**
 * Mutations are applied in the given order, each on its own: one failing item never blocks the rest.
 * `mutationId` makes every item idempotent, including kinds without a clientId (checkout, tag, decisions).
 */
export async function push(user: AuthUser, input: z.infer<typeof pushSchema>, meta: RequestMeta) {
  if (user.deviceId && input.deviceId !== user.deviceId) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'deviceId', message: 'does not match the signed-in device' }] });
  const handlers = owners<SyncMutationDef>((m) => m.syncMutations);
  const results: PushResult[] = [];
  let lastError: string | null = null;
  for (const m of input.mutations) {
    try {
      const h = handlers.get(m.entity);
      if (!h) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'entity', message: `unknown entity ${m.entity}` }] });
      if (!(await moduleOn(h.manifest, user))) throw new AppError('FEATURE_DISABLED', { flag: h.manifest.featureFlag?.key });
      if (h.def.permission && !(await can(user, h.def.permission))) throw new AppError('FORBIDDEN', { permission: h.def.permission });
      const r = await withIdempotency('sync', `${user.id}:${m.mutationId}`, payloadHash({ entity: m.entity, payload: JSON.stringify(m.payload) }, ['entity', 'payload']), async () => {
        const res = await h.def.apply(user, m.payload, { mutationId: m.mutationId, meta });
        return { statusCode: 200, body: res, entityId: res.entityId };
      });
      const b = r.body;
      results.push({ mutationId: m.mutationId, result: b.conflict ? 'conflict' : r.replayed || b.replayed ? 'replayed' : 'applied', entityId: b.entityId, ...(b.status ? { status: b.status } : {}), ...(b.conflict ? { conflict: b.conflict } : {}), ...(b.extra ?? {}) });
    } catch (e) {
      if (!(e instanceof AppError)) {
        // Unexpected failure: not final. The app keeps the item queued and retries it.
        ctx().logger.error({ err: e, entity: m.entity, mutationId: m.mutationId }, 'sync push item failed');
        lastError = `${m.entity}: INTERNAL`;
        results.push({ mutationId: m.mutationId, result: 'rejected', error: toProblem(new AppError('INTERNAL'), user.locale, meta.requestId), retryable: true });
        continue;
      }
      lastError = `${m.entity}: ${e.code}`;
      results.push({ mutationId: m.mutationId, result: 'rejected', error: toProblem(e, user.locale, meta.requestId), retryable: e.status >= 500 || e.code === 'INVALID_STATE' && (e.details as { reason?: string } | undefined)?.reason === 'REQUEST_IN_PROGRESS' });
    }
  }
  await touchState(user, { lastPushAt: now(), ...(input.pendingCount !== undefined ? { pendingReported: input.pendingCount } : {}), ...(input.mutations.length ? { lastError } : {}) });
  return { serverTime: now().toISOString(), results };
}

// ---------------- health (FR-SYNC-005) ----------------

export async function health(user: AuthUser, branchId?: string) {
  const rows = await DeviceSyncStateModel.find(branchQuery(user, branchId)).sort({ lastPullAt: -1 }).limit(500).lean();
  const names = await getUsers(rows.map((r) => r.userId));
  return rows.map((r) => ({
    userId: r.userId,
    userName: names.get(r.userId)?.name.en || names.get(r.userId)?.name.bn || '',
    deviceId: r.deviceId,
    ...(r.lastPullAt ? { lastPullAt: r.lastPullAt.toISOString() } : {}),
    ...(r.lastPushAt ? { lastPushAt: r.lastPushAt.toISOString() } : {}),
    pendingReported: r.pendingReported ?? 0,
    ...(r.lastError ? { lastError: r.lastError } : {}),
    ...(r.appVersion ? { appVersion: r.appVersion } : {}),
  }));
}
