import { Schema, model } from 'mongoose';
import { ctx } from '../../core/context/index.js';
import { AppError, notFound } from '../../core/errors/index.js';
import { isOid } from '../../core/db/index.js';
import { isSuperAdmin, type AuthUser } from '../../core/security/types.js';
import type { RequestMeta } from '../../core/http/router.js';
import * as audit from '../audit/index.js';
import { getUser, type UserView } from '../users/index.js';
import { isEnabledForUser } from '../flags/index.js';
import { getSetting } from '../settings/index.js';
import { revokeForDevice, type DeviceInfo } from '../auth/index.js';

const deviceSchema = new Schema(
  {
    deviceId: { type: String, required: true },
    userId: { type: String, required: true },
    branchId: { type: String, default: null },
    model: String,
    manufacturer: String,
    androidVersion: String,
    appVersion: String,
    status: { type: String, enum: ['active', 'pending_approval', 'unbound'], default: 'active' },
    boundAt: Date,
    unboundAt: { type: Date, default: null },
    lastSeenAt: Date,
    rooted: { type: Boolean, default: false },
    emulator: { type: Boolean, default: false },
    fcmToken: { type: String, default: null },
  },
  { collection: 'devices', versionKey: false, timestamps: true },
);
const DeviceModel = model('Device', deviceSchema);

type Row = Record<string, unknown> & { _id: { toHexString(): string } };
const view = (d: Row) => ({
  id: d._id.toHexString(),
  deviceId: d.deviceId as string,
  userId: d.userId as string,
  model: (d.model as string) ?? '',
  androidVersion: (d.androidVersion as string) ?? '',
  appVersion: (d.appVersion as string) ?? '',
  boundAt: d.boundAt ? (d.boundAt as Date).toISOString() : '',
  lastSeenAt: d.lastSeenAt ? (d.lastSeenAt as Date).toISOString() : '',
  rooted: !!d.rooted,
  emulator: !!d.emulator,
  status: d.status as 'active' | 'pending_approval' | 'unbound',
});

const asSubject = (u: UserView) => ({ id: u.id, role: u.role, branchIds: u.branchIds }) as unknown as AuthUser;

/**
 * FR-AUTH-007 login guard: a field staff account has at most N active devices (default 1).
 * First device binds automatically; a new device needs manager approval.
 */
export async function loginGuard(p: { user: UserView; client: 'app' | 'web'; deviceId: string | null; deviceInfo: DeviceInfo }): Promise<void> {
  if (p.client !== 'app') return;
  if (!(await isEnabledForUser('module.devices', asSubject(p.user)))) return;
  const bindRoles = await getSetting<string[]>('devices.bindRoles');
  if (!bindRoles.includes(p.user.role)) return;
  if (!p.deviceId) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'X-Device-Id', message: 'Device id header required' }] });
  const now = ctx().clock.now();
  const existing = await DeviceModel.findOne({ deviceId: p.deviceId }).lean();
  if (existing && existing.userId === p.user.id && existing.status === 'active') {
    await DeviceModel.updateOne({ _id: existing._id }, { $set: { lastSeenAt: now, appVersion: p.deviceInfo.appVersion ?? existing.appVersion } });
    return;
  }
  const max = await getSetting<number>('devices.maxPerUser');
  const active = await DeviceModel.countDocuments({ userId: p.user.id, status: 'active' });
  const fields = { userId: p.user.id, branchId: p.user.branchIds[0] ?? null, ...p.deviceInfo, lastSeenAt: now };
  if (active < max && (!existing || existing.status !== 'active')) {
    await DeviceModel.updateOne({ deviceId: p.deviceId }, { $set: { ...fields, status: 'active', boundAt: now, unboundAt: null } }, { upsert: true });
    await audit.record({ actor: { id: p.user.id, role: p.user.role }, action: 'device.bound', entity: 'device', entityId: p.deviceId, branchId: fields.branchId, after: p.deviceInfo });
    await ctx().bus.emit('device.bound', { userId: p.user.id, deviceId: p.deviceId });
    return;
  }
  await DeviceModel.updateOne({ deviceId: p.deviceId }, { $set: { ...fields, status: 'pending_approval' } }, { upsert: true });
  await ctx().bus.emit('device.approval_requested', { userId: p.user.id, deviceId: p.deviceId, branchId: fields.branchId });
  throw new AppError('DEVICE_NOT_APPROVED');
}

async function inScope(actor: AuthUser, userId: string): Promise<boolean> {
  const u = await getUser(userId);
  return !!u && (isSuperAdmin(actor) || u.branchIds.some((b) => actor.branchIds.includes(b)));
}

export async function list(actor: AuthUser, q: { branchId?: string; userId?: string }) {
  const filter: Record<string, unknown> = {};
  if (q.userId) filter.userId = q.userId;
  if (!isSuperAdmin(actor)) filter.branchId = q.branchId && actor.branchIds.includes(q.branchId) ? q.branchId : { $in: actor.branchIds };
  else if (q.branchId) filter.branchId = q.branchId;
  const rows = await DeviceModel.find(filter).sort({ updatedAt: -1 }).limit(500).lean();
  return rows.map((r) => view(r as unknown as Row));
}

async function load(actor: AuthUser, id: string) {
  if (!isOid(id)) throw notFound('device');
  const d = await DeviceModel.findById(id).lean();
  if (!d || !(await inScope(actor, d.userId))) throw notFound('device');
  return d;
}

export async function unbind(actor: AuthUser, id: string, reason: string, meta: RequestMeta) {
  const d = await load(actor, id);
  await DeviceModel.updateOne({ _id: d._id }, { $set: { status: 'unbound', unboundAt: ctx().clock.now(), fcmToken: null } });
  await revokeForDevice(d.deviceId, 'device_unbound');
  await audit.record({ actor, action: 'device.unbound', entity: 'device', entityId: d.deviceId, branchId: d.branchId ?? null, before: { status: d.status }, after: { status: 'unbound' }, reason, meta });
  await ctx().bus.emit('device.unbound', { userId: d.userId, deviceId: d.deviceId });
  return { id, status: 'unbound' };
}

export async function approve(actor: AuthUser, id: string, meta: RequestMeta) {
  const d = await load(actor, id);
  if (d.status !== 'pending_approval') throw new AppError('INVALID_STATE', { reason: 'NOT_PENDING' });
  const now = ctx().clock.now();
  // Approving a new device replaces the old one (max 1 by default).
  const max = await getSetting<number>('devices.maxPerUser');
  const actives = await DeviceModel.find({ userId: d.userId, status: 'active' }).sort({ lastSeenAt: 1 }).lean();
  for (const old of actives.slice(0, Math.max(0, actives.length - max + 1))) {
    await DeviceModel.updateOne({ _id: old._id }, { $set: { status: 'unbound', unboundAt: now, fcmToken: null } });
    await revokeForDevice(old.deviceId, 'replaced_by_new_device');
  }
  await DeviceModel.updateOne({ _id: d._id }, { $set: { status: 'active', boundAt: now } });
  await audit.record({ actor, action: 'device.approved', entity: 'device', entityId: d.deviceId, branchId: d.branchId ?? null, meta });
  await ctx().bus.emit('device.bound', { userId: d.userId, deviceId: d.deviceId });
  return { id, status: 'active' };
}

export async function registerPushToken(user: AuthUser, deviceId: string, fcmToken: string) {
  const now = ctx().clock.now();
  // Token belongs to one device; clear it elsewhere (reinstalls reuse tokens rarely, but be safe).
  await DeviceModel.updateMany({ fcmToken, deviceId: { $ne: deviceId } }, { $set: { fcmToken: null } });
  const existing = await DeviceModel.findOne({ deviceId }).lean();
  if (existing && existing.userId !== user.id) throw notFound('device');
  await DeviceModel.updateOne(
    { deviceId },
    { $set: { fcmToken, lastSeenAt: now }, $setOnInsert: { userId: user.id, branchId: user.branchIds[0] ?? null, status: 'active', boundAt: now } },
    { upsert: true },
  );
}

/** FCM tokens for users' active devices (notifications module). */
export async function pushTokensFor(userIds: string[]): Promise<{ userId: string; token: string; deviceId: string }[]> {
  const rows = await DeviceModel.find({ userId: { $in: userIds }, status: 'active', fcmToken: { $ne: null } }).lean();
  return rows.map((r) => ({ userId: r.userId, token: r.fcmToken!, deviceId: r.deviceId }));
}

export async function dropPushToken(token: string): Promise<void> {
  await DeviceModel.updateMany({ fcmToken: token }, { $set: { fcmToken: null } });
}

export async function touch(deviceId: string, appVersion?: string | null): Promise<void> {
  await DeviceModel.updateOne({ deviceId }, { $set: { lastSeenAt: ctx().clock.now(), ...(appVersion ? { appVersion } : {}) } });
}

