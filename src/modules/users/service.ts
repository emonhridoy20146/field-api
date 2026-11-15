import { z } from 'zod';
import { ctx } from '../../core/context/index.js';
import { AppError, businessRule, notFound } from '../../core/errors/index.js';
import { isDuplicateKey, isOid } from '../../core/db/index.js';
import { decodeCursor, encodeCursor } from '../../core/http/index.js';
import { hashPassword, normalizeBdPhone, temporaryPassword, verifyPassword } from '../../core/security/crypto.js';
import { ROLES, isSuperAdmin, type AuthUser, type Role } from '../../core/security/types.js';
import type { RequestMeta } from '../../core/http/router.js';
import * as audit from '../audit/index.js';
import { UserModel } from './models/user.model.js';

type UserDoc = NonNullable<Awaited<ReturnType<typeof UserModel.findById>>> & { _id: { toHexString(): string } };
type Lean = Record<string, unknown> & { _id: { toHexString(): string } };

export interface UserView {
  id: string;
  name: { bn: string; en: string };
  phone: string;
  username?: string;
  role: Role;
  branchIds: string[];
  employeeCode: string;
  erpEmployeeId: string | null;
  shiftId: string | null;
  cashLimitPoisha: number | null;
  active: boolean;
  mustChangePassword: boolean;
  locale: 'bn' | 'en';
  lastLoginAt: string | null;
  version: number;
}

export function toView(u: Lean | UserDoc): UserView {
  const x = u as unknown as Record<string, unknown> & { _id: { toHexString(): string }; name?: { bn?: string; en?: string } };
  return {
    id: x._id.toHexString(),
    name: { bn: x.name?.bn ?? '', en: x.name?.en ?? '' },
    phone: x.phone as string,
    ...(x.username ? { username: x.username as string } : {}),
    role: x.role as Role,
    branchIds: (x.branchIds as string[]) ?? [],
    employeeCode: x.employeeCode as string,
    erpEmployeeId: (x.erpEmployeeId as string | null) ?? null,
    shiftId: (x.shiftId as string | null) ?? null,
    cashLimitPoisha: (x.cashLimitPoisha as number | null) ?? null,
    active: x.active as boolean,
    mustChangePassword: x.mustChangePassword as boolean,
    locale: ((x.locale as string) ?? 'bn') as 'bn' | 'en',
    lastLoginAt: x.lastLoginAt ? (x.lastLoginAt as Date).toISOString() : null,
    version: (x.version as number) ?? 1,
  };
}

export const displayName = (u: { name: { bn: string; en: string } }, lang: 'bn' | 'en' = 'en') => u.name[lang] || u.name.en || u.name.bn;

// ---------- password policy (FR-AUTH-003) ----------
const COMMON = new Set(
  'password,password1,12345678,123456789,1234567890,qwerty123,11111111,00000000,iloveyou,bangladesh,dhaka1234,abcd1234,admin123,welcome1,letmein1,passw0rd,87654321,asdfghjk,zxcvbnm1,football,baseball,sunshine,princess,qwertyui,1q2w3e4r,monkey12,dragon12,master12,howlader,howlader1'.split(','),
);

export function checkPasswordPolicy(pw: string, phone: string): void {
  const digits = phone.replace(/\D/g, '');
  if (pw.length < 8) throw businessRule('PASSWORD_TOO_SHORT');
  if (COMMON.has(pw.toLowerCase())) throw businessRule('PASSWORD_TOO_COMMON');
  const pwDigits = pw.replace(/\D/g, '');
  if (pwDigits.length >= 10 && (digits.endsWith(pwDigits) || pwDigits.endsWith(digits.slice(-10)))) throw businessRule('PASSWORD_EQUALS_PHONE');
}

// ---------- scope helpers ----------
function canManageTarget(actor: AuthUser, target: { role: Role; branchIds: string[] }): boolean {
  if (isSuperAdmin(actor)) return true;
  // BM (when granted user.manage) may only manage FS/VW in their own branches.
  if (target.role === 'super_admin' || target.role === 'branch_manager') return false;
  return target.branchIds.length > 0 && target.branchIds.every((b) => actor.branchIds.includes(b));
}

function inViewScope(actor: AuthUser, target: { branchIds: string[] }): boolean {
  return isSuperAdmin(actor) || target.branchIds.some((b) => actor.branchIds.includes(b));
}

// ---------- queries ----------
export async function getUser(id: string): Promise<UserView | null> {
  if (!isOid(id)) return null;
  const u = await UserModel.findById(id).lean();
  return u ? toView(u as unknown as Lean) : null;
}

export async function getUsers(ids: string[]): Promise<Map<string, UserView>> {
  const rows = await UserModel.find({ _id: { $in: [...new Set(ids)].filter(isOid) } }).lean();
  return new Map(rows.map((r) => [r._id.toHexString(), toView(r as unknown as Lean)]));
}

export async function listStaff(branchId: string, role: Role = 'field_staff'): Promise<UserView[]> {
  return (await UserModel.find({ branchIds: branchId, role, active: true }).sort({ employeeCode: 1 }).lean()).map((u) => toView(u as unknown as Lean));
}

export async function listByRole(roles: Role[], branchIds?: string[]): Promise<UserView[]> {
  const filter: Record<string, unknown> = { role: { $in: roles }, active: true };
  if (branchIds) filter.branchIds = { $in: branchIds };
  return (await UserModel.find(filter).lean()).map((u) => toView(u as unknown as Lean));
}

export async function getUserInScope(actor: AuthUser, id: string): Promise<UserView> {
  const u = await getUser(id);
  if (!u || !inViewScope(actor, u)) throw notFound('user');
  return u;
}

export async function list(actor: AuthUser, q: { branchId?: string; role?: Role; active?: boolean; q?: string; limit: number; cursor?: string }) {
  const filter: Record<string, unknown> = {};
  if (!isSuperAdmin(actor)) filter.branchIds = q.branchId && actor.branchIds.includes(q.branchId) ? q.branchId : { $in: q.branchId ? [] : actor.branchIds };
  else if (q.branchId) filter.branchIds = q.branchId;
  if (q.role) filter.role = q.role;
  if (q.active !== undefined) filter.active = q.active;
  if (q.q) {
    const rx = new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ 'name.en': rx }, { 'name.bn': rx }, { phone: rx }, { employeeCode: rx }, { username: rx }];
  }
  const c = decodeCursor<{ id: string }>(q.cursor);
  if (c && isOid(c.id)) filter._id = { $gt: c.id };
  const rows = await UserModel.find(filter).sort({ _id: 1 }).limit(q.limit + 1).lean();
  const page = rows.slice(0, q.limit);
  return {
    items: page.map((u) => toView(u as unknown as Lean)),
    nextCursor: rows.length > q.limit ? encodeCursor({ id: page[page.length - 1]!._id.toHexString() }) : null,
  };
}

// ---------- commands ----------
const i18n = z.object({ bn: z.string().max(200).default(''), en: z.string().max(200).default('') }).refine((n) => n.bn || n.en, 'name required');
export const createSchema = z.object({
  name: i18n,
  phone: z.string(),
  username: z.string().regex(/^[a-z0-9._-]{3,40}$/).optional(),
  role: z.enum(ROLES as [Role, ...Role[]]),
  branchIds: z.array(z.string()).min(1),
  employeeCode: z.string().regex(/^[A-Z0-9-]{2,20}$/),
  erpEmployeeId: z.string().optional(),
  shiftId: z.string().optional(),
  cashLimitPoisha: z.number().int().positive().optional(),
});
export const updateSchema = z.object({
  name: i18n.optional(),
  phone: z.string().optional(),
  role: z.enum(ROLES as [Role, ...Role[]]).optional(),
  branchIds: z.array(z.string()).min(1).optional(),
  shiftId: z.string().nullable().optional(),
  cashLimitPoisha: z.number().int().positive().nullable().optional(),
  erpEmployeeId: z.string().nullable().optional(),
  locale: z.enum(['bn', 'en']).optional(),
  reason: z.string().optional(),
});

function phoneOrFail(p: string): string {
  const n = normalizeBdPhone(p);
  if (!n) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'phone', message: 'Invalid Bangladesh mobile number' }] });
  return n;
}

function dupError(e: unknown): never {
  const kv = (e as { keyValue?: Record<string, unknown> }).keyValue ?? {};
  throw businessRule('DUPLICATE_USER', { fields: Object.keys(kv) });
}

export async function create(actor: AuthUser, input: z.infer<typeof createSchema>, meta: RequestMeta) {
  if (!canManageTarget(actor, input)) throw new AppError('FORBIDDEN', { permission: 'user.manage', reason: 'role_or_branch_out_of_scope' });
  const temp = temporaryPassword();
  try {
    const doc = await UserModel.create({
      ...input,
      phone: phoneOrFail(input.phone),
      passwordHash: await hashPassword(temp),
      mustChangePassword: true,
    });
    const view = toView(doc as unknown as UserDoc);
    await audit.record({ actor, action: 'user.created', entity: 'user', entityId: view.id, branchId: view.branchIds[0] ?? null, after: view, meta });
    await ctx().bus.emit('user.created', { userId: view.id });
    return { user: view, temporaryPassword: temp };
  } catch (e) {
    if (isDuplicateKey(e)) dupError(e);
    throw e;
  }
}

async function activeSuperAdmins(excludeId?: string): Promise<number> {
  return UserModel.countDocuments({ role: 'super_admin', active: true, ...(excludeId ? { _id: { $ne: excludeId } } : {}) });
}

export async function update(actor: AuthUser, id: string, input: z.infer<typeof updateSchema>, ifMatch: number | null, meta: RequestMeta) {
  const before = await getUser(id);
  if (!before || !inViewScope(actor, before)) throw notFound('user');
  if (!canManageTarget(actor, before) || (input.role || input.branchIds ? !canManageTarget(actor, { role: input.role ?? before.role, branchIds: input.branchIds ?? before.branchIds }) : false))
    throw new AppError('FORBIDDEN', { permission: 'user.manage' });
  if (ifMatch !== null && ifMatch !== before.version) throw new AppError('PRECONDITION_FAILED', { currentVersion: before.version });
  // FR-RBAC-007: never demote the last active super admin.
  if (before.role === 'super_admin' && input.role && input.role !== 'super_admin' && (await activeSuperAdmins(id)) === 0) throw businessRule('LAST_SUPER_ADMIN');
  const { reason, ...rest } = input;
  const set: Record<string, unknown> = { ...rest };
  if (rest.phone) set.phone = phoneOrFail(rest.phone);
  try {
    const doc = await UserModel.findOneAndUpdate({ _id: id, version: before.version }, { $set: set, $inc: { version: 1 } }, { new: true }).lean();
    if (!doc) throw new AppError('PRECONDITION_FAILED');
    const after = toView(doc as unknown as Lean);
    await audit.record({ actor, action: 'user.updated', entity: 'user', entityId: id, branchId: after.branchIds[0] ?? null, before, after, reason: reason ?? null, meta });
    await ctx().bus.emit('user.updated', { userId: id, roleChanged: before.role !== after.role, branchesChanged: before.branchIds.join() !== after.branchIds.join() });
    return after;
  } catch (e) {
    if (isDuplicateKey(e)) dupError(e);
    throw e;
  }
}

export async function resetPassword(actor: AuthUser, id: string, meta: RequestMeta) {
  const u = await getUser(id);
  if (!u || !inViewScope(actor, u)) throw notFound('user');
  if (!canManageTarget(actor, u)) throw new AppError('FORBIDDEN', { permission: 'user.manage' });
  const temp = temporaryPassword();
  await UserModel.updateOne({ _id: id }, { $set: { passwordHash: await hashPassword(temp), mustChangePassword: true }, $inc: { version: 1 } });
  await audit.record({ actor, action: 'user.password_reset', entity: 'user', entityId: id, branchId: u.branchIds[0] ?? null, meta });
  await ctx().bus.emit('user.password_reset', { userId: id });
  return { temporaryPassword: temp };
}

export async function setActive(actor: AuthUser, id: string, active: boolean, reason: string | null, meta: RequestMeta) {
  const u = await getUser(id);
  if (!u || !inViewScope(actor, u)) throw notFound('user');
  if (!canManageTarget(actor, u)) throw new AppError('FORBIDDEN', { permission: 'user.manage' });
  if (!active && u.id === actor.id) throw businessRule('CANNOT_DEACTIVATE_SELF');
  if (!active && u.role === 'super_admin' && (await activeSuperAdmins(id)) === 0) throw businessRule('LAST_SUPER_ADMIN');
  if (!active && !reason) throw businessRule('REASON_REQUIRED');
  await UserModel.updateOne({ _id: id }, { $set: { active }, $inc: { version: 1 } });
  await audit.record({ actor, action: active ? 'user.activated' : 'user.deactivated', entity: 'user', entityId: id, branchId: u.branchIds[0] ?? null, before: { active: u.active }, after: { active }, reason, meta });
  await ctx().bus.emit(active ? 'user.activated' : 'user.deactivated', { userId: id, branchIds: u.branchIds, actorId: actor.id });
  return { id, active };
}

// ---------- used by auth ----------
export async function findForLogin(identifier: { phone?: string; username?: string }) {
  let filter: Record<string, unknown> | null = null;
  if (identifier.phone) {
    const p = normalizeBdPhone(identifier.phone);
    if (p) filter = { phone: p };
  } else if (identifier.username) filter = { username: identifier.username.toLowerCase() };
  if (!filter) return null;
  const u = await UserModel.findOne(filter).lean();
  if (!u) return null;
  return { view: toView(u as unknown as Lean), passwordHash: u.passwordHash };
}

export async function checkPassword(userId: string, password: string): Promise<boolean> {
  const u = await UserModel.findById(userId).select('passwordHash').lean();
  return !!u && (await verifyPassword(u.passwordHash, password));
}

export async function changeOwnPassword(userId: string, current: string, next: string): Promise<void> {
  const u = await UserModel.findById(userId).lean();
  if (!u) throw notFound('user');
  if (!(await verifyPassword(u.passwordHash, current))) throw new AppError('INVALID_CREDENTIALS');
  checkPasswordPolicy(next, u.phone);
  if (await verifyPassword(u.passwordHash, next)) throw businessRule('PASSWORD_REUSED');
  await UserModel.updateOne({ _id: userId }, { $set: { passwordHash: await hashPassword(next), mustChangePassword: false, passwordChangedAt: ctx().clock.now() }, $inc: { version: 1 } });
}

export async function markLogin(userId: string): Promise<void> {
  await UserModel.updateOne({ _id: userId }, { $set: { lastLoginAt: ctx().clock.now() } });
}

/** Port for the core auth hook: fresh user state on every request (deactivation is immediate). */
export async function loadAuthUser(userId: string, sessionId: string, client: 'app' | 'web', deviceId: string | null): Promise<AuthUser | null> {
  const u = await getUser(userId);
  if (!u || !u.active) return null;
  return {
    id: u.id,
    role: u.role,
    branchIds: u.branchIds,
    name: u.name,
    employeeCode: u.employeeCode,
    sessionId,
    deviceId,
    client,
    mustChangePassword: u.mustChangePassword,
    locale: u.locale,
  };
}

/** Trusted creation for seeds/tests (bypasses actor checks, still audited as system). */
export async function createSystemUser(input: z.infer<typeof createSchema> & { password: string; mustChangePassword?: boolean }): Promise<UserView> {
  const { password, mustChangePassword, ...rest } = input;
  const doc = await UserModel.create({ ...rest, phone: phoneOrFail(rest.phone), passwordHash: await hashPassword(password), mustChangePassword: mustChangePassword ?? false });
  const view = toView(doc as unknown as UserDoc);
  await audit.record({ actor: null, action: 'user.created', entity: 'user', entityId: view.id, branchId: view.branchIds[0] ?? null, after: view, reason: 'system seed' });
  return view;
}
