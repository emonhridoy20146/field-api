import { z } from 'zod';
import { ctx } from '../../core/context/index.js';
import { AppError, businessRule, notFound } from '../../core/errors/index.js';
import type { SettingDef } from '../../core/module/types.js';
import type { AuthUser } from '../../core/security/types.js';
import { isOid } from '../../core/db/index.js';
import { weekday } from '../../core/time/index.js';
import * as audit from '../audit/index.js';
import type { RequestMeta } from '../../core/http/router.js';
import { HolidayModel, SettingModel, ShiftModel } from './models/settings.model.js';
import { breakWindowSchema, cleanWindows, defaultShiftSchema, shiftSchema, type BreakWindow } from './domain/shift.js';

export function definitions(): SettingDef[] {
  return ctx().manifests.flatMap((m) => m.settings ?? []);
}

function def(key: string): SettingDef {
  const d = definitions().find((x) => x.key === key);
  if (!d) throw new Error(`Unknown setting ${key}`);
  return d;
}

const cache = new Map<string, { at: number; value: unknown }>();
const TTL_MS = 30_000;

export function clearSettingsCache(): void {
  cache.clear();
}

/** Typed setting value: branch override → global → manifest default. */
export async function getSetting<T = unknown>(key: string, branchId?: string | null): Promise<T> {
  const d = def(key);
  const ck = `${key}|${branchId ?? ''}`;
  const hit = cache.get(ck);
  const nowMs = Date.now();
  if (hit && nowMs - hit.at < TTL_MS) return hit.value as T;
  let value: unknown = d.default;
  const global = await SettingModel.findOne({ key, scope: 'global' }).lean();
  if (global) value = global.value;
  if (branchId && d.branchOverridable) {
    const b = await SettingModel.findOne({ key, scope: 'branch', branchId }).lean();
    if (b) value = b.value;
  }
  cache.set(ck, { at: nowMs, value });
  return value as T;
}

export async function getMany(keys: string[], branchId?: string | null): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = await getSetting(k, branchId);
  return out;
}

export function validateValue(d: SettingDef, v: unknown): unknown {
  const schema =
    d.type === 'int'
      ? z.number().int()
      : d.type === 'number'
        ? z.number()
        : d.type === 'bool'
          ? z.boolean()
          : d.type === 'string'
            ? z.string().max(2000)
            : d.type === 'enum'
              ? z.enum((d.enum ?? ['']) as [string, ...string[]])
              : (d.schema ?? z.unknown());
  const r = schema.safeParse(v);
  if (!r.success) {
    const issue = r.error.issues[0];
    // for a JSON value, say which part is wrong: `attendance.defaultShift.breakWindows.0.end`
    throw new AppError('VALIDATION_FAILED', { fields: [{ path: [d.key, ...(issue?.path ?? [])].join('.'), message: issue?.message ?? 'invalid' }] });
  }
  return r.data;
}

/** All settings visible to the user. Non-admins only see app-exposed keys. */
export async function view(user: AuthUser, canManage: boolean, branchId?: string): Promise<Record<string, unknown>> {
  const defs = definitions().filter((d) => canManage || d.exposeToApp);
  const b = branchId ?? (user.role === 'super_admin' ? undefined : user.branchIds[0]);
  return getMany(defs.map((d) => d.key), b);
}

export async function appSettings(branchId: string | null): Promise<Record<string, unknown>> {
  return getMany(definitions().filter((d) => d.exposeToApp).map((d) => d.key), branchId);
}

export async function update(
  user: AuthUser,
  input: { branchId?: string; changes: Record<string, unknown>; reason: string },
  meta: RequestMeta,
): Promise<Record<string, unknown>> {
  const scope = input.branchId ? 'branch' : 'global';
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input.changes)) {
    const d = definitions().find((x) => x.key === key);
    if (!d) throw new AppError('VALIDATION_FAILED', { fields: [{ path: key, message: 'Unknown setting' }] });
    if (scope === 'branch' && !d.branchOverridable) throw businessRule('SETTING_NOT_BRANCH_OVERRIDABLE', { key });
    const value = validateValue(d, raw);
    const before = await getSetting(key, input.branchId);
    await SettingModel.updateOne(
      { key, scope, branchId: input.branchId ?? null },
      { $set: { value, updatedBy: user.id, updatedAt: ctx().clock.now() } },
      { upsert: true },
    );
    await audit.record({
      actor: user,
      action: 'settings.changed',
      entity: 'setting',
      entityId: key,
      branchId: input.branchId ?? null,
      before: { value: before },
      after: { value },
      reason: input.reason,
      meta,
    });
    out[key] = value;
  }
  clearSettingsCache();
  await ctx().bus.emit('settings.changed', { keys: Object.keys(out), branchId: input.branchId ?? null });
  return out;
}

/** System write used by trusted code paths (e.g. migrations, seeds). Audited as system. */
export async function setSystem(key: string, value: unknown, branchId?: string): Promise<void> {
  const d = def(key);
  const v = validateValue(d, value);
  await SettingModel.updateOne({ key, scope: branchId ? 'branch' : 'global', branchId: branchId ?? null }, { $set: { value: v, updatedAt: ctx().clock.now() } }, { upsert: true });
  await audit.record({ actor: null, action: 'settings.changed', entity: 'setting', entityId: key, branchId: branchId ?? null, after: { value: v }, reason: 'system' });
  clearSettingsCache();
}

// ---------- holidays & shifts (FR-SET-002/003) ----------

export const holidaySchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    name: z.object({ bn: z.string().trim().min(1).max(100), en: z.string().trim().min(1).max(100) }),
    branchIds: z.array(z.string().max(64)).max(100).default([]),
    type: z.enum(['national', 'branch']).default('national'),
  })
  // A branch holiday names its branches; a national one applies everywhere (1.12.0).
  .refine((h) => (h.type === 'branch') === h.branchIds.length > 0, { message: 'branch holidays need branchIds; national ones none', path: ['branchIds'] });

const holidayView = (h: { _id: { toHexString(): string }; date: string; name?: { bn?: string | null; en?: string | null } | null; branchIds: string[]; type?: string | null }) => ({
  id: h._id.toHexString(),
  date: h.date,
  name: { bn: h.name?.bn ?? '', en: h.name?.en ?? '' },
  branchIds: h.branchIds,
  type: (h.type ?? 'national') as 'national' | 'branch',
});

/** Holidays of a year (or all). `branchId` keeps national holidays and that branch's own (1.12.0). */
export async function listHolidays(year?: number, branchId?: string) {
  const filter: Record<string, unknown> = year ? { date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } } : {};
  if (branchId) filter.$or = [{ branchIds: { $size: 0 } }, { branchIds: branchId }];
  const rows = await HolidayModel.find(filter).sort({ date: 1 }).lean();
  return rows.map(holidayView);
}

export async function createHoliday(user: AuthUser, input: z.infer<typeof holidaySchema>, meta: RequestMeta) {
  // The same day twice for an overlapping set of branches is a mistake, not two holidays.
  const clash = await HolidayModel.exists({ date: input.date, $or: [{ branchIds: { $size: 0 } }, ...(input.branchIds.length ? [{ branchIds: { $in: input.branchIds } }] : [{}])] });
  if (clash) throw new AppError('INVALID_STATE', { reason: 'HOLIDAY_EXISTS', date: input.date });
  const doc = await HolidayModel.create({ ...input, createdBy: user.id });
  await audit.record({ actor: user, action: 'holiday.created', entity: 'holiday', entityId: doc._id.toHexString(), after: input, meta });
  return holidayView(doc);
}

/** Remove a holiday entered by mistake (1.12.0). Days already finalised are not re-derived. */
export async function deleteHoliday(user: AuthUser, id: string, meta: RequestMeta): Promise<void> {
  if (!isOid(id)) throw notFound('holiday');
  const before = await HolidayModel.findByIdAndDelete(id).lean();
  if (!before) throw notFound('holiday');
  await audit.record({ actor: user, action: 'holiday.deleted', entity: 'holiday', entityId: id, before: holidayView(before), meta });
}

export async function isHoliday(date: string, branchId: string | null): Promise<boolean> {
  const h = await HolidayModel.findOne({ date, $or: [{ branchIds: { $size: 0 } }, ...(branchId ? [{ branchIds: branchId }] : [])] }).lean();
  return !!h;
}

export { breakWindowSchema, defaultShiftSchema, shiftSchema, type BreakWindow };

export interface ShiftView {
  id: string;
  name: string;
  start: string;
  end: string;
  weeklyOff: number[];
  lateGraceMin: number;
  maxBreakMin: number;
  /** 1.25.0; empty when none. */
  breakWindows: BreakWindow[];
}

const shiftView = (s: { _id: { toHexString(): string }; name: string; start: string; end: string; weeklyOff: number[]; lateGraceMin: number; maxBreakMin: number; breakWindows?: unknown }): ShiftView => ({
  id: s._id.toHexString(),
  name: s.name,
  start: s.start,
  end: s.end,
  weeklyOff: s.weeklyOff,
  lateGraceMin: s.lateGraceMin,
  maxBreakMin: s.maxBreakMin,
  breakWindows: cleanWindows(s.breakWindows),
});

export async function listShifts(): Promise<ShiftView[]> {
  return (await ShiftModel.find().sort({ name: 1 }).lean()).map(shiftView);
}

export async function createShift(user: AuthUser, input: z.infer<typeof shiftSchema>, meta: RequestMeta) {
  if (input.start >= input.end) throw businessRule('SHIFT_END_BEFORE_START');
  const doc = await ShiftModel.create(input);
  await audit.record({ actor: user, action: 'shift.created', entity: 'shift', entityId: doc._id.toHexString(), after: input, meta });
  return shiftView(doc);
}

export async function updateShift(user: AuthUser, id: string, input: Partial<z.infer<typeof shiftSchema>>, meta: RequestMeta) {
  if (!isOid(id)) throw notFound('shift');
  const before = await ShiftModel.findById(id).lean();
  if (!before) throw notFound('shift');
  const next = { ...before, ...input };
  if (next.start >= next.end) throw businessRule('SHIFT_END_BEFORE_START');
  const doc = await ShiftModel.findByIdAndUpdate(id, { $set: input, $inc: { version: 1 } }, { new: true }).lean();
  await audit.record({ actor: user, action: 'shift.updated', entity: 'shift', entityId: id, before: shiftView(before), after: input, meta });
  return shiftView(doc!);
}

/** Shift for a user: explicit shiftId → default shift setting values (OD-14). */
export async function resolveShift(shiftId: string | null | undefined, branchId: string | null): Promise<ShiftView> {
  if (shiftId && isOid(shiftId)) {
    const s = await ShiftModel.findById(shiftId).lean();
    if (s) return shiftView(s);
  }
  const d = await getSetting<{ start: string; end: string; weeklyOff: number[]; lateGraceMin: number; maxBreakMin: number; breakWindows?: unknown }>('attendance.defaultShift', branchId);
  return { id: 'default', name: 'Default', ...d, breakWindows: cleanWindows(d.breakWindows) };
}

/** Working day = not weekly off for the shift and not a holiday. */
export async function isWorkingDay(date: string, shift: ShiftView, branchId: string | null): Promise<boolean> {
  if (shift.weeklyOff.includes(weekday(date))) return false;
  return !(await isHoliday(date, branchId));
}
