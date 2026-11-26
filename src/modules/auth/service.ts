import { randomUUID } from 'node:crypto';
import { ctx } from '../../core/context/index.js';
import { AppError, notFound } from '../../core/errors/index.js';
import { isOid } from '../../core/db/index.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../../core/security/crypto.js';
import { signAccessToken } from '../../core/security/jwt.js';
import { sharesBranch, type AuthUser } from '../../core/security/types.js';
import type { RequestMeta } from '../../core/http/router.js';
import * as audit from '../audit/index.js';
import { changeOwnPassword, findForLogin, getUser, loadAuthUser, markLogin, type UserView } from '../users/index.js';
import { attendanceRequired } from '../attendance/index.js';
import { effectivePermissions } from '../rbac/index.js';
import { flagsFor } from '../flags/index.js';
import { getSetting } from '../settings/index.js';
import { LoginAttemptModel, SessionModel, TrackingTokenModel } from './models/session.model.js';

export type LoginGuard = (ctx: { user: UserView; client: 'app' | 'web'; deviceId: string | null; deviceInfo: DeviceInfo }) => Promise<void>;
export interface DeviceInfo {
  model?: string | null;
  manufacturer?: string | null;
  androidVersion?: string | null;
  appVersion?: string | null;
}

const guards: LoginGuard[] = [];
/** Other modules (devices) may veto a login, e.g. 403 DEVICE_NOT_APPROVED. */
export function registerLoginGuard(g: LoginGuard): void {
  guards.push(g);
}

let dummy: Promise<string> | null = null;
const dummyHash = () => (dummy ??= hashPassword(randomToken()));

/** FR-AUTH-005: an account locks after this many failures in the window. */
const LOCK_FAILURES = 5;
const LOCK_WINDOW_MS = 15 * 60_000;

/**
 * Time the key unlocks, or null. `threshold` failures inside the window lock the key until the newest of them
 * is a full window old. A threshold of 0 or less turns the key off.
 */
async function lockedUntil(key: string, threshold: number): Promise<Date | null> {
  if (threshold <= 0) return null;
  const since = new Date(ctx().clock.now().getTime() - LOCK_WINDOW_MS);
  const fails = await LoginAttemptModel.find({ key, success: false, at: { $gte: since } }).sort({ at: -1 }).limit(threshold).lean();
  return fails.length >= threshold ? new Date(fails[0]!.at.getTime() + LOCK_WINDOW_MS) : null;
}

function lockedError(until: Date, scope: 'account' | 'ip'): AppError {
  const retryAfterSec = Math.max(1, Math.ceil((until.getTime() - ctx().clock.now().getTime()) / 1000));
  return new AppError('ACCOUNT_LOCKED', { until: until.toISOString(), retryAfterSec, scope });
}

/**
 * 1.47.0 (ADR-064): a user whose IP is locked may still log in from a device or browser that already had a
 * session of theirs: the app's X-Device-Id of an earlier session, or admin-web's refresh cookie. Staff behind one
 * office or carrier NAT share an IP, so a stranger's mistakes must not lock them out; an attacker who guesses
 * passwords across accounts from that IP has neither, so the IP lock still stops them.
 */
async function knownClient(userId: string, deviceId: string | null, cookieToken: string | undefined): Promise<boolean> {
  if (deviceId && (await SessionModel.exists({ userId, deviceId }))) return true;
  if (cookieToken) {
    const h = sha256(cookieToken);
    if (await SessionModel.exists({ userId, $or: [{ refreshTokenHash: h }, { previousTokenHashes: h }] })) return true;
  }
  return false;
}

export interface LoginInput {
  phone?: string | undefined;
  username?: string | undefined;
  password: string;
  client: 'app' | 'web';
  /** admin-web's fos_rt cookie, if the browser still has one (only used to recognise a known browser). */
  cookieToken?: string | undefined;
}

async function issueTokens(user: UserView, client: 'app' | 'web', meta: RequestMeta, familyId?: string, prev?: { id: string; hashes: string[] }) {
  const cfg = ctx().config;
  const now = ctx().clock.now();
  const refreshToken = `rt_${randomToken(32)}`;
  const ttlMs = client === 'app' ? cfg.REFRESH_TOKEN_TTL_DAYS_APP * 86400_000 : cfg.REFRESH_TOKEN_TTL_HOURS_WEB * 3600_000;
  const expiresAt = new Date(now.getTime() + ttlMs);
  let sessionId: string;
  if (prev) {
    sessionId = prev.id;
    await SessionModel.updateOne(
      { _id: prev.id },
      { $set: { refreshTokenHash: sha256(refreshToken), lastUsedAt: now, expiresAt, ip: meta.ip }, $push: { previousTokenHashes: { $each: prev.hashes, $slice: -20 } } },
    );
  } else {
    const s = await SessionModel.create({
      userId: user.id,
      familyId: familyId ?? randomUUID(),
      refreshTokenHash: sha256(refreshToken),
      deviceId: meta.deviceId,
      client,
      userAgent: meta.userAgent,
      ip: meta.ip,
      lastUsedAt: now,
      expiresAt,
    });
    sessionId = s._id.toHexString();
  }
  const access = await signAccessToken({ sub: user.id, sid: sessionId, role: user.role }, now, cfg.ACCESS_TOKEN_TTL_SEC);
  const authUser = (await loadAuthUser(user.id, sessionId, client, meta.deviceId))!;
  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt.toISOString(),
    refreshToken,
    refreshTokenExpiresAt: expiresAt.toISOString(),
    user,
    ...(await permissionSnapshot(authUser)),
    serverTime: now.toISOString(),
  };
}

export async function login(input: LoginInput, meta: RequestMeta, deviceInfo: DeviceInfo) {
  const ident = input.phone ?? input.username ?? '';
  const acctKey = `acct:${ident.replace(/\s/g, '').toLowerCase()}`;
  const ipKey = `ip:${meta.ip}`;
  // FR-AUTH-005: the account lock (5 / 15 min) always applies. The IP lock has a much higher threshold (setting
  // auth.ipLockFailures, default 50) and does not stop a known device or browser of the user (ADR-064).
  const acctUntil = await lockedUntil(acctKey, LOCK_FAILURES);
  if (acctUntil) throw lockedError(acctUntil, 'account');
  const ipUntil = await lockedUntil(ipKey, await getSetting<number>('auth.ipLockFailures'));
  const found = await findForLogin({ phone: input.phone, username: input.username });
  if (ipUntil && !(found && (await knownClient(found.view.id, meta.deviceId, input.cookieToken)))) {
    // Same answer whether or not the user exists or the password is right: no oracle for a locked IP.
    throw lockedError(ipUntil, 'ip');
  }
  // Always run one argon2 verification so unknown users take as long as known ones.
  const ok = (await verifyPassword(found?.passwordHash ?? (await dummyHash()), input.password)) && !!found;
  const at = ctx().clock.now();
  if (!found || !ok || !found.view.active) {
    await LoginAttemptModel.insertMany([
      { key: acctKey, at, success: false },
      { key: ipKey, at, success: false },
    ]);
    await audit.record({ actor: found ? { id: found.view.id, role: found.view.role } : null, action: 'auth.login_failed', entity: 'user', entityId: found?.view.id ?? null, branchId: found?.view.branchIds[0] ?? null, after: { identifier: acctKey.slice(0, 9) + '…' }, meta });
    await ctx().bus.emit('auth.login_failed', { userId: found?.view.id ?? null });
    throw new AppError('INVALID_CREDENTIALS');
  }
  for (const g of guards) await g({ user: found.view, client: input.client, deviceId: meta.deviceId, deviceInfo });
  await LoginAttemptModel.create({ key: acctKey, at, success: true });
  await markLogin(found.view.id);
  const tokens = await issueTokens(found.view, input.client, meta);
  await audit.record({ actor: found.view, action: 'auth.login', entity: 'user', entityId: found.view.id, branchId: found.view.branchIds[0] ?? null, after: { client: input.client }, meta });
  await ctx().bus.emit('auth.login', { userId: found.view.id, client: input.client, deviceId: meta.deviceId, deviceInfo });
  return tokens;
}

export async function refresh(token: string | undefined, meta: RequestMeta) {
  if (!token) throw new AppError('UNAUTHENTICATED');
  const hash = sha256(token);
  const now = ctx().clock.now();
  const s = await SessionModel.findOne({ refreshTokenHash: hash }).lean();
  if (!s) {
    // Unknown token: if it matches a rotated one, the family is compromised → revoke all (FR-AUTH-002).
    const reused = await SessionModel.findOne({ previousTokenHashes: hash }).lean();
    if (reused) {
      await SessionModel.updateMany({ familyId: reused.familyId, revokedAt: null }, { $set: { revokedAt: now, revokedReason: 'refresh_reuse' } });
      await audit.record({ actor: { id: reused.userId, role: null }, action: 'auth.refresh_reused', entity: 'session', entityId: reused._id.toHexString(), meta });
      await ctx().bus.emit('auth.session_revoked', { userId: reused.userId, reason: 'refresh_reuse' });
      throw new AppError('REFRESH_REUSED');
    }
    throw new AppError('UNAUTHENTICATED');
  }
  if (s.revokedAt || s.expiresAt <= now) throw new AppError('UNAUTHENTICATED');
  const user = await getUser(s.userId);
  if (!user || !user.active) throw new AppError('UNAUTHENTICATED');
  return issueTokens(user, s.client as 'app' | 'web', { ...meta, deviceId: s.deviceId ?? null }, s.familyId, { id: s._id.toHexString(), hashes: [s.refreshTokenHash] });
}

export async function logout(user: AuthUser, meta: RequestMeta) {
  await revoke(user.sessionId, 'logout');
  // ADR-067: logging out stops the native location service too (all of the user's tracking tokens).
  await revokeTrackingTokens({ userId: user.id }, 'logout', user, meta);
  await audit.record({ actor: user, action: 'auth.logout', entity: 'session', entityId: user.sessionId, meta });
}

async function revoke(sessionId: string, reason: string, actor?: AuthUser, meta?: RequestMeta) {
  await SessionModel.updateOne({ _id: sessionId, revokedAt: null }, { $set: { revokedAt: ctx().clock.now(), revokedReason: reason } });
  await revokeTrackingTokens({ sessionId }, reason, actor, meta);
}

export async function revokeAllForUser(userId: string, reason: string, exceptSessionId?: string): Promise<number> {
  const r = await SessionModel.updateMany(
    { userId, revokedAt: null, ...(exceptSessionId ? { _id: { $ne: exceptSessionId } } : {}) },
    { $set: { revokedAt: ctx().clock.now(), revokedReason: reason } },
  );
  await revokeTrackingTokens({ userId, ...(exceptSessionId ? { sessionId: { $ne: exceptSessionId } } : {}) }, reason);
  if (r.modifiedCount) await ctx().bus.emit('auth.session_revoked', { userId, reason });
  return r.modifiedCount;
}

export async function revokeForDevice(deviceId: string, reason: string): Promise<void> {
  await SessionModel.updateMany({ deviceId, revokedAt: null }, { $set: { revokedAt: ctx().clock.now(), revokedReason: reason } });
  await revokeTrackingTokens({ deviceId }, reason);
}

// ---------------- tracking tokens (1.49.0, FR-LOC-013, ADR-067) ----------------

/** `details.reason` of the 401 a tracking token gets; the native service never refreshes, it keeps points buffered. */
export type TrackingTokenProblem = 'TRACKING_TOKEN_INVALID' | 'TRACKING_TOKEN_EXPIRED' | 'TRACKING_TOKEN_NOT_ALLOWED';
const trackingError = (reason: TrackingTokenProblem) => new AppError('UNAUTHENTICATED', { reason });
const TRACKING_TOKEN_RE = /^trk_[A-Za-z0-9_-]{40,60}$/;

/** Revokes the live tracking tokens matching `filter` and audits it once per affected user. */
async function revokeTrackingTokens(filter: Record<string, unknown>, reason: string, actor?: AuthUser, meta?: RequestMeta): Promise<number> {
  const rows = await TrackingTokenModel.find({ ...filter, revokedAt: null }, { userId: 1 }).lean();
  if (!rows.length) return 0;
  await TrackingTokenModel.updateMany({ _id: { $in: rows.map((r) => r._id) }, revokedAt: null }, { $set: { revokedAt: ctx().clock.now(), revokedReason: reason } });
  const perUser = new Map<string, number>();
  for (const r of rows) perUser.set(r.userId, (perUser.get(r.userId) ?? 0) + 1);
  for (const [userId, count] of perUser)
    await audit.record({ actor: actor ?? null, action: 'auth.tracking_token_revoked', entity: 'user', entityId: userId, after: { reason, count }, ...(meta ? { meta } : {}) });
  return rows.length;
}

/**
 * Issues a new tracking token for the caller's app session and revokes the previous one of this user and device
 * (rotation). The caller (location) decides who may have one and for how long.
 */
export async function issueTrackingToken(user: AuthUser, ttlHours: number, meta: RequestMeta): Promise<{ token: string; expiresAt: string }> {
  if (user.client !== 'app' || !user.deviceId || user.via === 'tracking') throw new AppError('FORBIDDEN', { reason: 'APP_ONLY' });
  const now = ctx().clock.now();
  const token = `trk_${randomToken(32)}`;
  const expiresAt = new Date(now.getTime() + ttlHours * 3600_000);
  const replaced = await TrackingTokenModel.updateMany({ userId: user.id, deviceId: user.deviceId, revokedAt: null }, { $set: { revokedAt: now, revokedReason: 'rotated' } });
  await TrackingTokenModel.create({ userId: user.id, deviceId: user.deviceId, sessionId: user.sessionId, tokenHash: sha256(token), expiresAt });
  await audit.record({ actor: user, action: 'auth.tracking_token_issued', entity: 'user', entityId: user.id, branchId: user.branchIds[0] ?? null, after: { deviceId: user.deviceId, expiresAt: expiresAt.toISOString(), replaced: replaced.modifiedCount }, meta });
  return { token, expiresAt: expiresAt.toISOString() };
}

/**
 * Resolves `Authorization: Tracking <token>` to the user, or throws 401 with `details.reason`. The token must be
 * live, its session live and on the same device, and the user active. The device check is the caller's (location).
 */
export async function resolveTrackingToken(token: string): Promise<AuthUser> {
  if (!TRACKING_TOKEN_RE.test(token)) throw trackingError('TRACKING_TOKEN_INVALID');
  const now = ctx().clock.now();
  const t = await TrackingTokenModel.findOne({ tokenHash: sha256(token) }).lean();
  if (!t || t.revokedAt) throw trackingError('TRACKING_TOKEN_INVALID');
  if (t.expiresAt <= now) throw trackingError('TRACKING_TOKEN_EXPIRED');
  const s = isOid(t.sessionId) ? await SessionModel.findById(t.sessionId).lean() : null;
  if (!s || s.revokedAt || s.expiresAt <= now || s.userId !== t.userId || s.deviceId !== t.deviceId) throw trackingError('TRACKING_TOKEN_INVALID');
  const user = await loadAuthUser(t.userId, t.sessionId, 'app', t.deviceId);
  if (!user) throw trackingError('TRACKING_TOKEN_INVALID');
  await TrackingTokenModel.updateOne({ _id: t._id }, { $set: { lastUsedAt: now } });
  return { ...user, via: 'tracking' };
}

export async function changePassword(user: AuthUser, current: string, next: string, meta: RequestMeta) {
  await changeOwnPassword(user.id, current, next);
  await revokeAllForUser(user.id, 'password_changed', user.sessionId);
  await audit.record({ actor: user, action: 'auth.password_changed', entity: 'user', entityId: user.id, branchId: user.branchIds[0] ?? null, meta });
}

export async function me(user: AuthUser) {
  const u = await getUser(user.id);
  return { user: u, ...(await permissionSnapshot(user)) };
}

/** Permissions, flags and (1.45.0, FR-ATT-014) whether the user must do attendance: login, refresh and /auth/me. */
async function permissionSnapshot(user: AuthUser) {
  const perms = await effectivePermissions(user);
  const flags = await flagsFor(user);
  return { permissions: [...perms].sort(), flags, attendanceRequired: attendanceRequired(perms, !!flags['module.attendance']) };
}

export async function listSessions(userId: string, currentSessionId: string) {
  const rows = await SessionModel.find({ userId, revokedAt: null, expiresAt: { $gt: ctx().clock.now() } }).sort({ lastUsedAt: -1 }).lean();
  return rows.map((s) => ({
    id: s._id.toHexString(),
    client: s.client,
    deviceId: s.deviceId ?? '',
    userAgent: s.userAgent ?? '',
    ip: s.ip ?? '',
    createdAt: (s as unknown as { createdAt: Date }).createdAt.toISOString(),
    lastUsedAt: s.lastUsedAt.toISOString(),
    current: s._id.toHexString() === currentSessionId,
  }));
}

export async function revokeSession(actor: AuthUser, sessionId: string, canManageOthers: boolean, meta: RequestMeta) {
  if (!isOid(sessionId)) throw notFound('session');
  const s = await SessionModel.findById(sessionId).lean();
  if (!s) throw notFound('session');
  if (s.userId !== actor.id) {
    const target = await getUser(s.userId);
    const inScope = target && sharesBranch(actor, target);
    if (!canManageOthers || !inScope) throw notFound('session');
  }
  await revoke(sessionId, s.userId === actor.id ? 'self_revoked' : 'admin_revoked', actor, meta);
  await audit.record({ actor, action: 'auth.session_revoked', entity: 'session', entityId: sessionId, after: { userId: s.userId }, meta });
}

/** Port for the core auth hook: the session must be live and the user active. */
export async function resolveAuthUser(claims: { sub: string; sid: string }): Promise<AuthUser | null> {
  if (!isOid(claims.sid)) return null;
  const s = await SessionModel.findById(claims.sid).lean();
  if (!s || s.revokedAt || s.userId !== claims.sub) return null;
  return loadAuthUser(claims.sub, claims.sid, s.client as 'app' | 'web', s.deviceId ?? null);
}
