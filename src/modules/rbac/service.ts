import { Schema, model } from 'mongoose';
import { ctx } from '../../core/context/index.js';
import { AppError, businessRule, notFound } from '../../core/errors/index.js';
import { isOid, withTransaction } from '../../core/db/index.js';
import { nextSeq, CounterModel } from '../../core/changefeed/index.js';
import type { PermissionDef } from '../../core/module/types.js';
import type { AuthUser, Role } from '../../core/security/types.js';
import { canSeeBranch, isSuperAdmin } from '../../core/security/types.js';
import type { RequestMeta } from '../../core/http/router.js';
import * as audit from '../audit/index.js';
import { getUser, listByRole } from '../users/index.js';
import { evaluate, effectiveSet, type Override } from './domain/evaluate.js';

const overrideSchema = new Schema(
  {
    level: { type: String, enum: ['branch', 'user'], required: true },
    branchId: { type: String, default: null },
    role: { type: String, default: null },
    userId: { type: String, default: null },
    key: { type: String, required: true },
    effect: { type: String, enum: ['allow', 'deny'], required: true },
    reason: String,
    setBy: String,
    setAt: Date,
  },
  { collection: 'permission_overrides', versionKey: false },
);
const OverrideModel = model('PermissionOverride', overrideSchema);

export function catalog(): (PermissionDef & { module: string })[] {
  return ctx().manifests.flatMap((m) => m.permissions.map((p) => ({ ...p, module: m.name })));
}

const cache = new Map<string, { at: number; perms: Set<string> }>();
const TTL_MS = 60_000;

export function invalidate(userId?: string): void {
  if (!userId) return cache.clear();
  for (const k of cache.keys()) if (k.startsWith(`${userId}|`)) cache.delete(k);
}

async function overridesFor(subject: { id: string; branchIds: string[] }): Promise<Override[]> {
  return (await OverrideModel.find({ $or: [{ level: 'user', userId: subject.id }, { level: 'branch', branchId: { $in: subject.branchIds } }] }).lean()) as unknown as Override[];
}

/** Cached 60 s per (user, role, branches); invalidated on rbac.changed / user.updated. */
export async function effectivePermissions(user: { id: string; role: Role; branchIds: string[] }): Promise<Set<string>> {
  const key = `${user.id}|${user.role}|${user.branchIds.join(',')}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.perms;
  const perms = effectiveSet(user, catalog(), await overridesFor(user));
  cache.set(key, { at: Date.now(), perms });
  return perms;
}

export async function can(user: AuthUser, key: string): Promise<boolean> {
  return (await effectivePermissions(user)).has(key);
}

/** Global permission version, bumped on every override change (sent to devices in sync pull). */
export async function permissionsVersion(): Promise<number> {
  return (await CounterModel.findById('rbac_version').lean())?.value ?? 0;
}

export async function explain(actor: AuthUser, userId: string) {
  const u = await getUser(userId);
  if (!u || (!isSuperAdmin(actor) && !u.branchIds.some((b) => actor.branchIds.includes(b)))) throw notFound('user');
  const ov = await overridesFor(u);
  return catalog().map((d) => ({ key: d.key, ...evaluate(u, d, ov) }));
}

export interface OverrideChange {
  key: string;
  effect: 'allow' | 'deny' | 'inherit';
}

function checkKeys(changes: OverrideChange[]) {
  const cat = new Map(catalog().map((d) => [d.key, d]));
  for (const c of changes) {
    const d = cat.get(c.key);
    if (!d) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'changes', message: `Unknown permission ${c.key}` }] });
    if (d.reserved && c.effect === 'allow') throw businessRule('RESERVED_PERMISSION', { key: c.key });
  }
}

async function applyChanges(
  actor: AuthUser,
  scope: { level: 'branch'; branchId: string; role: Role } | { level: 'user'; userId: string; branchId: string | null },
  changes: OverrideChange[],
  reason: string,
  meta: RequestMeta,
) {
  checkKeys(changes);
  const baseFilter = scope.level === 'branch' ? { level: 'branch', branchId: scope.branchId, role: scope.role } : { level: 'user', userId: scope.userId };
  await withTransaction(async (session) => {
    for (const c of changes) {
      const filter = { ...baseFilter, key: c.key };
      const before = await OverrideModel.findOne(filter).session(session).lean();
      if (c.effect === 'inherit') await OverrideModel.deleteOne(filter, { session });
      else
        await OverrideModel.updateOne(filter, { $set: { effect: c.effect, reason, setBy: actor.id, setAt: ctx().clock.now() } }, { upsert: true, session });
      await audit.record(
        {
          actor,
          action: 'rbac.override.set',
          entity: scope.level === 'branch' ? 'branch_permission' : 'user_permission',
          entityId: scope.level === 'branch' ? `${scope.branchId}:${scope.role}` : scope.userId,
          branchId: scope.branchId,
          before: { key: c.key, effect: before?.effect ?? 'inherit' },
          after: { key: c.key, effect: c.effect },
          reason,
          meta,
        },
        session,
      );
    }
    await nextSeq('rbac_version', session);
  });
  invalidate();
  await ctx().bus.emit('rbac.changed', scope.level === 'user' ? { userIds: [scope.userId] } : { branchId: scope.branchId, role: scope.role });
}

export async function setBranchOverrides(actor: AuthUser, branchId: string, role: Role, changes: OverrideChange[], reason: string, meta: RequestMeta) {
  if (role === 'super_admin') throw businessRule('SUPER_ADMIN_NOT_OVERRIDABLE');
  await applyChanges(actor, { level: 'branch', branchId, role }, changes, reason, meta);
  return { ok: true };
}

export async function setUserOverrides(actor: AuthUser, userId: string, changes: OverrideChange[], reason: string, meta: RequestMeta) {
  const u = await getUser(userId);
  if (!u) throw notFound('user');
  if (u.role === 'super_admin') throw businessRule('SUPER_ADMIN_NOT_OVERRIDABLE');
  await applyChanges(actor, { level: 'user', userId, branchId: u.branchIds[0] ?? null }, changes, reason, meta);
  return { ok: true };
}

/** Users who hold a key within a branch (for notifications/inbox routing, e.g. tag.approve holders). */
export async function holdersOf(key: string, branchId: string): Promise<string[]> {
  const candidates = await listByRole(['super_admin', 'branch_manager', 'viewer', 'field_staff'], [branchId]);
  const sas = await listByRole(['super_admin']);
  const all = new Map([...candidates, ...sas].map((u) => [u.id, u]));
  const out: string[] = [];
  for (const u of all.values()) if ((await effectivePermissions(u)).has(key)) out.push(u.id);
  return out;
}

/** Current exceptions for a branch (all roles), for the admin permissions matrix (contract 1.3.0). */
export async function listBranchOverrides(actor: AuthUser, branchId: string) {
  if (!canSeeBranch(actor, branchId)) throw notFound('branch');
  const rows = await OverrideModel.find({ level: 'branch', branchId }).sort({ role: 1, key: 1 }).lean();
  return { branchId, items: rows.map((o) => ({ role: o.role, key: o.key, effect: o.effect, reason: o.reason ?? '', setBy: o.setBy ?? '', setAt: o.setAt ? o.setAt.toISOString() : null })) };
}

export async function listUserOverrides(actor: AuthUser, userId: string) {
  const u = isOid(userId) ? await getUser(userId) : null;
  if (!u || !u.branchIds.some((b) => canSeeBranch(actor, b))) throw notFound('user');
  const rows = await OverrideModel.find({ level: 'user', userId }).sort({ key: 1 }).lean();
  return { userId, items: rows.map((o) => ({ key: o.key, effect: o.effect, reason: o.reason ?? '', setBy: o.setBy ?? '', setAt: o.setAt ? o.setAt.toISOString() : null })) };
}
