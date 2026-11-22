import { z } from 'zod';
import { ctx } from '../../core/context/index.js';
import { AppError, businessRule, notFound } from '../../core/errors/index.js';
import { isDuplicateKey, isOid, newId, withTransaction, type LeanDoc, type LooseObject } from '../../core/db/index.js';
import { recordChange } from '../../core/changefeed/index.js';
import { addDays, businessDate, dhakaInstant, isIsoDate } from '../../core/time/index.js';
import { branchQuery, canSeeBranch, isSuperAdmin, type AuthUser } from '../../core/security/types.js';
import type { RequestMeta } from '../../core/http/router.js';
import * as audit from '../audit/index.js';
import { getSetting, isHoliday, resolveShift, type ShiftView } from '../settings/index.js';
import { getUser, getUsers, listByRole, type UserView } from '../users/index.js';
import { isUploadedBy, markMediaDeleted, removeDeletedMediaFiles, type RemovalBatch } from '../media/index.js';
import { autoCloseAt, deriveDay, dutyIntervals, dutyStateAt, lateAbsences, type DayEvent, type DayKind, type DutyIntervals, type EventType } from './domain/day.js';
import { AttendanceDayModel, AttendanceEventModel, LeaveModel } from './models/attendance.model.js';
import { weekday } from '../../core/time/index.js';

type Lean = LeanDoc;
const today = () => businessDate(ctx().clock.now());

export const SELFIE_EVENT_TYPES = ['work_in', 'break_start', 'break_end', 'work_out'] as const;
/** 1.36.0 (owner 2026-11-22): by default a photo only at work-in and work-out, not at breaks. */
export const DEFAULT_SELFIE_EVENTS = ['work_in', 'work_out'] as const;

export const eventSchema = z.object({
  clientId: z.string().uuid(),
  type: z.enum(['work_in', 'break_start', 'break_end', 'work_out']),
  at: z.string().datetime({ offset: true }),
  deviceTime: z.string().datetime({ offset: true }).optional(),
  geo: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().min(0), mock: z.boolean().default(false) }).passthrough().nullable(),
  geoUnavailableReason: z.enum(['permission_denied', 'location_off', 'timeout', 'no_fix']).optional(),
  selfieMediaId: z.string().max(64).optional(),
});

async function kindOf(userId: string, date: string, shift: ShiftView, branchId: string | null): Promise<DayKind> {
  if (await LeaveModel.exists({ userId, status: 'approved', from: { $lte: date }, to: { $gte: date } })) return 'leave';
  if (await isHoliday(date, branchId)) return 'holiday';
  if (shift.weeklyOff.includes(weekday(date))) return 'weekly_off';
  return 'working';
}

/**
 * What kind of day each date is for each person (working, weekly off, holiday, leave), with the same
 * rules as the attendance day. Used by targets, so a target never applies to a day off. Batched:
 * one leave query and one holiday lookup per branch and date.
 */
export async function dayKindsOf(people: { id: string; shiftId: string | null; branchId: string | null }[], from: string, to: string): Promise<Map<string, Map<string, DayKind>>> {
  const leaves = (await LeaveModel.find({ userId: { $in: people.map((p) => p.id) }, status: 'approved', from: { $lte: to }, to: { $gte: from } }).lean()) as Lean[];
  const holidays = new Map<string, boolean>();
  const holiday = async (date: string, branchId: string | null) => {
    const k = `${branchId ?? ''}:${date}`;
    if (!holidays.has(k)) holidays.set(k, await isHoliday(date, branchId));
    return holidays.get(k)!;
  };
  const out = new Map<string, Map<string, DayKind>>();
  for (const p of people) {
    const shift = await resolveShift(p.shiftId, p.branchId);
    const mine = leaves.filter((l) => l.userId === p.id);
    const days = new Map<string, DayKind>();
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (mine.some((l) => l.from <= d && l.to >= d)) days.set(d, 'leave');
      else if (await holiday(d, p.branchId)) days.set(d, 'holiday');
      else if (shift.weeklyOff.includes(weekday(d))) days.set(d, 'weekly_off');
      else days.set(d, 'working');
    }
    out.set(p.id, days);
  }
  return out;
}

function dayView(userId: string, date: string, d: LooseObject) {
  const iso = (x: Date | null | undefined) => (x ? new Date(x).toISOString() : null);
  return {
    userId,
    businessDate: date,
    status: d.status,
    firstIn: iso(d.firstIn),
    lastOut: iso(d.lastOut),
    lateMin: d.lateMin ?? 0,
    breakMin: d.breakMin ?? 0,
    dutyMin: d.dutyMin ?? 0,
    overBreakMin: d.overBreakMin ?? 0,
    overtimeMin: d.overtimeMin ?? 0,
    breaks: (d.breaks ?? []).map((b: { start: Date; end: Date | null }) => ({ start: iso(b.start)!, end: iso(b.end) })),
    autoClosed: !!d.autoClosed,
    corrected: !!d.corrected,
    flags: d.flags ?? [],
  };
}

/** Rebuild the derived day from its events and store it. Returns the contract view. */
export async function recompute(user: Pick<UserView, 'id' | 'branchIds' | 'shiftId'>, date: string) {
  const branchId = user.branchIds[0] ?? null;
  const shift = await resolveShift(user.shiftId, branchId);
  const rows = (await AttendanceEventModel.find({ userId: user.id, businessDate: date, replacedBy: null }).lean()) as Lean[];
  const events: DayEvent[] = rows.map((e) => ({ id: e._id.toHexString(), type: e.type as EventType, at: e.at }));
  const now = ctx().clock.now();
  const shiftEnd = dhakaInstant(date, shift.end);
  const autoClosed = rows.some((e) => e.source === 'system' && e.type === 'work_out');
  const closed = date < today() || autoClosed;
  const day = weekday(date);
  const breakWindows = shift.breakWindows.filter((w) => w.weekday === day).map((w) => ({ start: dhakaInstant(date, w.start), end: dhakaInstant(date, w.end) }));
  const overtimeAfterMin = await getSetting<number>('attendance.overtimeAfterMin', branchId);
  const r = deriveDay({ events, shiftStart: dhakaInstant(date, shift.start), shiftEnd, lateGraceMin: shift.lateGraceMin, maxBreakMin: shift.maxBreakMin, breakWindows, overtimeAfterMin, autoClosed, kind: await kindOf(user.id, date, shift, branchId), now, closed });
  const flags = [...r.flags, ...new Set(rows.flatMap((e) => e.flags as string[]))].filter((f, i, a) => a.indexOf(f) === i);
  const doc = {
    userId: user.id,
    branchId,
    businessDate: date,
    status: r.status,
    state: r.state,
    firstIn: r.firstIn,
    lastOut: r.lastOut,
    lateMin: r.lateMin,
    breakMin: r.breakMin,
    dutyMin: r.dutyMin,
    overBreakMin: r.overBreakMin,
    windowBreakMin: r.windowBreakMin,
    overtimeMin: r.overtimeMin,
    breaks: r.breaks,
    autoClosed,
    corrected: rows.some((e) => e.source === 'correction'),
    closed,
    flags,
    shift: { start: shift.start, end: shift.end },
    updatedAt: now,
  };
  await AttendanceDayModel.updateOne({ userId: user.id, businessDate: date }, { $set: doc }, { upsert: true });
  return dayView(user.id, date, doc);
}

/** FR-ATT-001/002: accept every well-formed event (idempotent by clientId); sequence anomalies are flagged, not rejected. */
export async function recordEvent(user: AuthUser, input: z.infer<typeof eventSchema>) {
  const u = await getUser(user.id);
  if (!u) throw notFound('user');
  const at = new Date(input.at);
  const date = businessDate(at);
  const prior = await AttendanceEventModel.findOne({ clientId: input.clientId }).lean();
  if (prior) {
    if (prior.userId !== user.id) throw new AppError('IDEMPOTENCY_MISMATCH', { clientId: input.clientId });
    return { statusCode: 200 as const, body: await recompute(u, prior.businessDate) };
  }
  const now = ctx().clock.now();
  const flags: string[] = [];
  if (input.geo?.mock) flags.push('mock_location');
  if (!input.geo) flags.push('no_location');
  if (input.deviceTime && Math.abs(new Date(input.deviceTime).getTime() - at.getTime()) > 5 * 60_000) flags.push('clock_skew');
  if (at.getTime() - now.getTime() > 5 * 60_000) flags.push('clock_skew');
  if (now.getTime() - at.getTime() > 12 * 3_600_000) flags.push('late_sync');
  // Only a photo this user uploaded counts; an id that is not theirs is treated as no photo at all.
  const selfieMediaId = input.selfieMediaId && (await isUploadedBy(input.selfieMediaId, user.id)) ? input.selfieMediaId : null;
  if (!selfieMediaId && (await photoEvents(u.branchIds[0] ?? null)).has(input.type)) flags.push('no_selfie');
  try {
    await AttendanceEventModel.create({
      clientId: input.clientId,
      userId: user.id,
      branchId: u.branchIds[0] ?? null,
      businessDate: date,
      type: input.type,
      at,
      deviceTime: input.deviceTime ? new Date(input.deviceTime) : null,
      receivedAt: now,
      geo: input.geo ? { lat: input.geo.lat, lng: input.geo.lng, accuracyM: input.geo.accuracyM, mock: input.geo.mock } : null,
      geoUnavailableReason: input.geo ? null : (input.geoUnavailableReason ?? 'no_fix'),
      selfieMediaId,
      flags: [...new Set(flags)],
    });
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    return { statusCode: 200 as const, body: await recompute(u, date) };
  }
  const day = await recompute(u, date);
  await recordChange({ entity: 'attendance_day', entityId: `${user.id}:${date}`, userIds: [user.id], branchId: u.branchIds[0] ?? null });
  await ctx().bus.emit('attendance.event', { userId: user.id, branchId: u.branchIds[0] ?? null, businessDate: date, type: input.type, at, status: day.status, flags: day.flags });
  return { statusCode: 201 as const, body: day };
}

export const attachSelfieSchema = z.object({
  eventClientId: z.string().uuid(),
  selfieMediaId: z.string().max(64),
});

/**
 * Adds the photo to an attendance event that reached the server without it (contract 1.21.0, owner request
 * 2026-11-19: "image upload or not does not matter"). The app now sends every event at once and the photo after
 * it, so duty, attendance and location never wait for an upload. Only the person's own event and own uploaded photo;
 * an event that already has a photo keeps it. Removes the `no_selfie` flag.
 */
export async function attachSelfie(user: AuthUser, input: z.infer<typeof attachSelfieSchema>) {
  const ev = (await AttendanceEventModel.findOne({ clientId: input.eventClientId }).lean()) as Lean | null;
  if (!ev || ev.userId !== user.id) throw notFound('attendance_event');
  if (!(await isUploadedBy(input.selfieMediaId, user.id))) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'selfieMediaId', message: 'not a photo you uploaded' }] });
  // A photo an admin deleted is not replaced from the phone's queue (FR-MED-004).
  if (!ev.selfieMediaId && !ev.selfieDeleted) await AttendanceEventModel.updateOne({ _id: ev._id, selfieMediaId: null, selfieDeleted: null }, { $set: { selfieMediaId: input.selfieMediaId }, $pull: { flags: 'no_selfie' } });
  const u = await getUser(user.id);
  if (!u) throw notFound('user');
  const day = await recompute(u, ev.businessDate as string);
  await recordChange({ entity: 'attendance_day', entityId: `${user.id}:${ev.businessDate}`, userIds: [user.id], branchId: u.branchIds[0] ?? null });
  return day;
}

/** Event types that need a photo in this branch (FR-ATT-001). Unknown values in the setting are ignored. */
export async function photoEvents(branchId: string | null): Promise<Set<string>> {
  if (!(await getSetting<boolean>('attendance.selfieRequired', branchId))) return new Set();
  const v = await getSetting<unknown>('attendance.selfieEvents', branchId);
  return new Set((Array.isArray(v) ? v : DEFAULT_SELFIE_EVENTS).filter((t): t is string => (SELFIE_EVENT_TYPES as readonly unknown[]).includes(t)));
}

/**
 * One staff member's raw events of a day for managers (photo, place and flags per event). Corrected
 * events stay in the list, marked `replaced`, so the original is always visible.
 */
export async function eventsOfDay(user: AuthUser, q: { userId: string; date: string }) {
  if (!isIsoDate(q.date)) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'date', message: 'YYYY-MM-DD' }] });
  if (!(await staffInScope(user, undefined, q.userId)).length) throw notFound('user');
  const rows = (await AttendanceEventModel.find({ userId: q.userId, businessDate: q.date }).sort({ at: 1 }).lean()) as Lean[];
  return rows.map((e) => ({
    id: e._id.toHexString(),
    type: e.type as string,
    at: (e.at as Date).toISOString(),
    geo: e.geo ? { lat: e.geo.lat, lng: e.geo.lng, accuracyM: e.geo.accuracyM, mock: !!e.geo.mock } : null,
    selfieMediaId: (e.selfieMediaId ?? null) as string | null,
    selfieDeleted: e.selfieDeleted ? { at: (e.selfieDeleted.at as Date).toISOString(), by: e.selfieDeleted.by as string, byName: e.selfieDeleted.byName as string } : null,
    flags: (e.flags ?? []) as string[],
    source: (e.source ?? 'app') as string,
    replaced: !!e.replacedBy,
  }));
}

export const deletePhotosSchema = z.object({
  userId: z.string().max(64),
  date: z.string().refine(isIsoDate, 'YYYY-MM-DD'),
  reason: z.string().trim().max(500).optional(),
});

/**
 * FR-MED-004 (1.37.0): an admin deletes one staff member's attendance photos of one day. The events keep a log in place
 * of the photo (`selfieDeleted`); the files leave Cloudinary and the base store (media module). Branch scope → 404.
 */
export async function deletePhotosOfDay(actor: AuthUser, input: z.infer<typeof deletePhotosSchema>, meta: RequestMeta) {
  const [u] = isOid(input.userId) ? await staffInScope(actor, undefined, input.userId) : [];
  if (!u) throw notFound('user');
  const rows = (await AttendanceEventModel.find({ userId: u.id, businessDate: input.date, selfieMediaId: { $ne: null } }).lean()) as Lean[];
  let batches: RemovalBatch[] = [];
  if (rows.length) {
    const mediaIds = rows.map((e) => e.selfieMediaId as string);
    const at = ctx().clock.now();
    const byName = actor.name.en || actor.name.bn || actor.employeeCode;
    await withTransaction(async (session) => {
      ({ batches } = await markMediaDeleted(mediaIds, actor, { scope: 'attendance_day', reason: input.reason ?? null }, session));
      for (const e of rows)
        await AttendanceEventModel.updateOne({ _id: e._id }, { $set: { selfieMediaId: null, selfieDeleted: { at, by: actor.id, byName, mediaId: e.selfieMediaId } } }, { session });
      await audit.record(
        { actor, action: 'attendance.photos_deleted', entity: 'attendance_day', entityId: `${u.id}:${input.date}`, branchId: u.branchIds[0] ?? null, before: { mediaIds }, after: { deleted: mediaIds.length }, reason: input.reason ?? null, meta },
        session,
      );
    });
    await removeDeletedMediaFiles(batches);
  }
  return { deleted: rows.length, events: await eventsOfDay(actor, { userId: u.id, date: input.date }) };
}

/**
 * 1.36.0: today's day with its events, so a phone that lost its local data (app reinstalled, data cleared) restores
 * the work-in, breaks and work-out already recorded instead of asking for attendance again.
 */
export async function myToday(user: AuthUser) {
  const u = await getUser(user.id);
  if (!u) throw notFound('user');
  const day = await recompute(u, today());
  const rows = (await AttendanceEventModel.find({ userId: u.id, businessDate: today(), replacedBy: null }).sort({ at: 1, _id: 1 }).lean()) as Lean[];
  return { ...day, events: rows.map((e) => ({ id: e._id.toHexString(), clientId: (e.clientId as string | null) ?? null, type: e.type as string, at: (e.at as Date).toISOString(), source: (e.source as string | undefined) ?? 'app' })) };
}

/** One of the caller's own days (sync pull). */
export async function dayOf(user: AuthUser, date: string) {
  const u = await getUser(user.id);
  if (!u) throw notFound('user');
  return recompute(u, date);
}

/** Dashboard counters for today in the caller's scope. */
export async function todayCounts(user: AuthUser, branchId?: string) {
  const all = await days(user, { branchId, from: today(), to: today() });
  return {
    present: all.filter((d) => d.firstIn !== null).length,
    late: all.filter((d) => d.firstIn !== null && d.lateMin > 0).length,
    absent: all.filter((d) => d.status === 'absent').length,
    onDutyNow: all.filter((d) => d.status === 'on_duty').length,
  };
}

/** Is the user on duty (work-in, not on break / out) at this instant? Used to refuse off-duty location points. */
export async function isOnDuty(userId: string, at: Date): Promise<boolean> {
  const date = businessDate(at);
  const rows = (await AttendanceEventModel.find({ userId, businessDate: date, replacedBy: null, at: { $lte: at } }).lean()) as Lean[];
  const r = deriveDay({ events: rows.map((e) => ({ id: e._id.toHexString(), type: e.type, at: e.at })), shiftStart: at, shiftEnd: at, lateGraceMin: 0, maxBreakMin: 0, kind: 'working', now: at, closed: false });
  return r.state === 'on_duty';
}

/**
 * Duty and break ranges of a user for the business dates touching [from, to]. An open day counts
 * only until its auto-close time (shift end + 3 h), so nothing is "on duty" past that (FR-LOC-001).
 */
export async function dutyWindows(userId: string, from: Date, to: Date): Promise<DutyIntervals> {
  const u = await getUser(userId);
  const out: DutyIntervals = { duty: [], breaks: [] };
  if (!u) return out;
  const shift = await resolveShift(u.shiftId, u.branchIds[0] ?? null);
  const rows = (await AttendanceEventModel.find({ userId, businessDate: { $gte: businessDate(from), $lte: businessDate(to) }, replacedBy: null }).lean()) as Lean[];
  const byDate = new Map<string, DayEvent[]>();
  for (const e of rows) byDate.set(e.businessDate, [...(byDate.get(e.businessDate) ?? []), { id: e._id.toHexString(), type: e.type as EventType, at: e.at }]);
  for (const [date, events] of byDate) {
    const i = dutyIntervals(events, autoCloseAt(dhakaInstant(date, shift.end)));
    out.duty.push(...i.duty);
    out.breaks.push(...i.breaks);
  }
  return out;
}

/** Field staff of the caller's scope who are on duty (or on break) right now, with that state. */
export async function onDutyNow(user: AuthUser, branchId?: string): Promise<Map<string, { name: string; branchId: string | null; onBreak: boolean }>> {
  const now = ctx().clock.now();
  const out = new Map<string, { name: string; branchId: string | null; onBreak: boolean }>();
  for (const s of await staffInScope(user, branchId)) {
    const state = dutyStateAt(await dutyWindows(s.id, now, now), now);
    if (state !== 'off_duty') out.set(s.id, { name: s.name.en || s.name.bn, branchId: s.branchIds[0] ?? null, onBreak: state === 'on_break' });
  }
  return out;
}

/**
 * Where each person's last attendance event of the day was taken (work-in, break end…), for the live map before the
 * phone's first tracked point arrives (ADR-041). Events without a position are skipped.
 */
export async function lastEventGeo(userIds: string[], date: string): Promise<Map<string, { lat: number; lng: number; accuracyM: number; mock: boolean; at: Date }>> {
  const out = new Map<string, { lat: number; lng: number; accuracyM: number; mock: boolean; at: Date }>();
  if (!userIds.length) return out;
  const rows = (await AttendanceEventModel.find({ userId: { $in: userIds }, businessDate: date, 'geo.lat': { $type: 'number' } }).sort({ at: 1 }).lean()) as Lean[];
  for (const r of rows) out.set(r.userId as string, { lat: r.geo.lat as number, lng: r.geo.lng as number, accuracyM: (r.geo.accuracyM as number) ?? 0, mock: !!r.geo.mock, at: r.at as Date });
  return out;
}

/** Every active field staff member who is on duty right now (system jobs; no caller scope). */
export async function allOnDutyNow(): Promise<{ userId: string; branchId: string | null; onBreak: boolean }[]> {
  const now = ctx().clock.now();
  const out: { userId: string; branchId: string | null; onBreak: boolean }[] = [];
  for (const s of await listByRole(['field_staff'])) {
    const state = dutyStateAt(await dutyWindows(s.id, now, now), now);
    if (state !== 'off_duty') out.push({ userId: s.id, branchId: s.branchIds[0] ?? null, onBreak: state === 'on_break' });
  }
  return out;
}

async function staffInScope(user: AuthUser, branchId?: string, userId?: string): Promise<UserView[]> {
  if (branchId && !canSeeBranch(user, branchId)) return [];
  const staff = await listByRole(['field_staff'], branchId ? [branchId] : isSuperAdmin(user) ? undefined : user.branchIds);
  return userId ? staff.filter((s) => s.id === userId) : staff;
}

/** Day grid for a date range (max 62 days); days without events are derived (absent / holiday / weekly off / leave). */
export async function days(user: AuthUser, q: { branchId?: string | undefined; userId?: string | undefined; from: string; to: string }) {
  if (!isIsoDate(q.from) || !isIsoDate(q.to) || q.to < q.from || q.to > addDays(q.from, 62)) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'to', message: 'from..to must be at most 62 days' }] });
  const staff = await staffInScope(user, q.branchId, q.userId);
  const end = q.to > today() ? today() : q.to;
  const stored = await AttendanceDayModel.find({ userId: { $in: staff.map((s) => s.id) }, businessDate: { $gte: q.from, $lte: end } }).lean();
  const byKey = new Map(stored.map((d) => [`${d.userId}:${d.businessDate}`, d]));
  const out = [];
  for (const s of staff)
    for (let d = q.from; d <= end; d = addDays(d, 1)) {
      const hit = byKey.get(`${s.id}:${d}`);
      // Stored closed days are final; everything else is recomputed so "today" is always live.
      // A closed day stored before 1.25.0 has no overtime yet: it is derived once more, then it is final again.
      out.push(hit && hit.closed && typeof hit.overtimeMin === 'number' ? dayView(s.id, d, hit) : await recompute(s, d));
    }
  return out;
}

export async function summary(user: AuthUser, q: { branchId?: string | undefined; month: string }) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(q.month)) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'month', message: 'YYYY-MM' }] });
  const from = `${q.month}-01`;
  const [y, m] = q.month.split('-').map(Number) as [number, number];
  const to = `${q.month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  const all = await days(user, { branchId: q.branchId, from, to });
  const names = await getUsers([...new Set(all.map((d) => d.userId))]);
  const rows = new Map<string, Record<string, number | string>>();
  const perAbsent = await getSetting<number>('attendance.lateDaysPerAbsent', null);
  for (const d of all) {
    const r = rows.get(d.userId) ?? { userId: d.userId, userName: names.get(d.userId)?.name.en ?? '', present: 0, late: 0, absent: 0, leave: 0, holiday: 0, weeklyOff: 0, lateMin: 0, breakMin: 0, dutyMin: 0, overBreakDays: 0, overBreakMin: 0, overtimeMin: 0, overtimeDays: 0, offDaysWorked: 0, lateAbsences: 0 };
    const worked = d.firstIn !== null;
    if (worked) (r.present as number)++;
    if (worked && d.lateMin > 0) (r.late as number)++;
    if (d.status === 'absent') (r.absent as number)++;
    if (d.status === 'leave') (r.leave as number)++;
    if (d.status === 'holiday') (r.holiday as number)++;
    if (d.status === 'weekly_off') (r.weeklyOff as number)++;
    r.lateMin = (r.lateMin as number) + d.lateMin;
    r.breakMin = (r.breakMin as number) + d.breakMin;
    r.dutyMin = (r.dutyMin as number) + d.dutyMin;
    if (d.flags.includes('over_break')) (r.overBreakDays as number)++;
    r.overBreakMin = (r.overBreakMin as number) + d.overBreakMin;
    r.overtimeMin = (r.overtimeMin as number) + d.overtimeMin;
    if (d.overtimeMin > 0) (r.overtimeDays as number)++;
    // weekly off day or holiday worked (work during approved leave carries the flag too, but no overtime)
    if (d.flags.includes('worked_on_off_day') && d.overtimeMin > 0) (r.offDaysWorked as number)++;
    r.lateAbsences = lateAbsences(r.late as number, perAbsent);
    rows.set(d.userId, r);
  }
  return { month: q.month, items: [...rows.values()] };
}

// ---------------- corrections (FR-ATT-006) ----------------

export const correctionSchema = z.object({
  userId: z.string().max(64),
  businessDate: z.string().refine(isIsoDate, 'YYYY-MM-DD'),
  type: z.enum(['work_in', 'break_start', 'break_end', 'work_out']),
  at: z.string().datetime({ offset: true }),
  replacesEventId: z.string().max(64).optional(),
  reason: z.string().trim().min(5).max(500),
});

export async function correct(actor: AuthUser, input: z.infer<typeof correctionSchema>, meta: RequestMeta) {
  const u = isOid(input.userId) ? await getUser(input.userId) : null;
  if (!u || !u.branchIds.some((b) => canSeeBranch(actor, b))) throw notFound('user');
  if (u.id === actor.id) throw businessRule('CANNOT_CORRECT_OWN_ATTENDANCE');
  const at = new Date(input.at);
  if (businessDate(at) !== input.businessDate) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'at', message: 'must fall on businessDate (Asia/Dhaka)' }] });
  if (input.businessDate > today()) throw businessRule('FUTURE_DATE');
  const id = newId();
  await withTransaction(async (session) => {
    let before: unknown = null;
    if (input.replacesEventId) {
      if (!isOid(input.replacesEventId)) throw notFound('attendance_event');
      const old = await AttendanceEventModel.findOneAndUpdate({ _id: input.replacesEventId, userId: u.id, businessDate: input.businessDate, replacedBy: null }, { $set: { replacedBy: id } }, { session }).lean();
      if (!old) throw notFound('attendance_event');
      before = { type: old.type, at: old.at };
    }
    await AttendanceEventModel.create(
      [{ _id: id, clientId: `correction:${id}`, userId: u.id, branchId: u.branchIds[0] ?? null, businessDate: input.businessDate, type: input.type, at, receivedAt: ctx().clock.now(), source: 'correction', correction: { by: actor.id, reason: input.reason, replacesEventId: input.replacesEventId ?? null } }],
      { session },
    );
    await audit.record({ actor, action: 'attendance.corrected', entity: 'attendance_day', entityId: `${u.id}:${input.businessDate}`, branchId: u.branchIds[0] ?? null, before, after: { type: input.type, at }, reason: input.reason, meta }, session);
  });
  const day = await recompute(u, input.businessDate);
  await recordChange({ entity: 'attendance_day', entityId: `${u.id}:${input.businessDate}`, userIds: [u.id], branchId: u.branchIds[0] ?? null });
  await ctx().bus.emit('attendance.corrected', { userId: u.id, businessDate: input.businessDate, by: actor.id });
  return { eventId: id, day };
}

// ---------------- jobs ----------------

/** FR-ATT-005: close days still open 3 h after shift end with a system work-out at that time. */
export async function autoClose(): Promise<number> {
  const now = ctx().clock.now();
  const open = await AttendanceDayModel.find({ state: { $in: ['on_duty', 'on_break'] }, closed: false }).lean();
  let n = 0;
  for (const d of open) {
    const u = await getUser(d.userId);
    if (!u) continue;
    const shift = await resolveShift(u.shiftId, u.branchIds[0] ?? null);
    // A day that started yesterday is closed at its own shift end + 3 h.
    const closeAt = autoCloseAt(dhakaInstant(d.businessDate, shift.end));
    if (now < closeAt) continue;
    const id = newId();
    await AttendanceEventModel.create({ _id: id, clientId: `auto:${d.userId}:${d.businessDate}`, userId: d.userId, branchId: d.branchId, businessDate: d.businessDate, type: 'work_out', at: closeAt, receivedAt: now, source: 'system', flags: ['auto_closed'] }).catch((e) => {
      if (!isDuplicateKey(e)) throw e;
    });
    await recompute(u, d.businessDate);
    await recordChange({ entity: 'attendance_day', entityId: `${d.userId}:${d.businessDate}`, userIds: [d.userId], branchId: d.branchId });
    await ctx().bus.emit('attendance.auto_closed', { userId: d.userId, branchId: d.branchId, businessDate: d.businessDate });
    n++;
  }
  return n;
}

/** Nightly: materialize yesterday for every active field staff (absent / off days) and emit absences. */
export async function finalize(date = addDays(today(), -1)): Promise<number> {
  const staff = await listByRole(['field_staff']);
  let absent = 0;
  for (const s of staff) {
    const before = await AttendanceDayModel.findOne({ userId: s.id, businessDate: date }).lean();
    const d = await recompute(s, date);
    if (d.status === 'absent' && before?.status !== 'absent') {
      absent++;
      await ctx().bus.emit('attendance.absent', { userId: s.id, branchId: s.branchIds[0] ?? null, businessDate: date });
    }
  }
  return absent;
}

// ---------------- leave (FR-ATT-008) ----------------

export const leaveSchema = z
  .object({ type: z.enum(['casual', 'sick', 'other']), from: z.string().refine(isIsoDate), to: z.string().refine(isIsoDate), reason: z.string().max(500).optional() })
  .refine((l) => l.to >= l.from, { message: 'to before from', path: ['to'] });

const leaveView = (l: Lean, name?: string) => ({
  id: l._id.toHexString(),
  userId: l.userId,
  ...(name !== undefined ? { userName: name } : {}),
  branchId: l.branchId ?? null,
  type: l.type,
  from: l.from,
  to: l.to,
  days: daysBetween(l.from, l.to),
  reason: l.reason ?? '',
  status: l.status,
  ...(l.decidedBy ? { decidedBy: l.decidedBy, decidedAt: (l.decidedAt as Date).toISOString() } : {}),
  ...(l.decisionReason ? { decisionReason: l.decisionReason } : {}),
  ...(l.cancelledAt ? { cancelledAt: (l.cancelledAt as Date).toISOString() } : {}),
  createdAt: (l.createdAt as Date).toISOString(),
});

/** Calendar days from `from` to `to`, both included. */
function daysBetween(from: string, to: string): number {
  let n = 1;
  for (let d = from; d < to && n <= 62; d = addDays(d, 1)) n++;
  return n;
}

export async function requestLeave(user: AuthUser, input: z.infer<typeof leaveSchema>) {
  if (input.to > addDays(input.from, 30)) throw businessRule('LEAVE_TOO_LONG', { maxDays: 31 });
  if (await LeaveModel.exists({ userId: user.id, status: { $in: ['pending', 'approved'] }, from: { $lte: input.to }, to: { $gte: input.from } })) throw new AppError('INVALID_STATE', { reason: 'LEAVE_OVERLAPS' });
  const l = await LeaveModel.create({ ...input, reason: input.reason ?? null, userId: user.id, branchId: user.branchIds[0] ?? null, createdAt: ctx().clock.now() });
  await ctx().bus.emit('leave.requested', { leaveId: l._id.toHexString(), userId: user.id, branchId: user.branchIds[0] ?? null });
  return leaveView(l.toObject() as Lean);
}

export const leaveListSchema = z
  .object({
    branchId: z.string().max(64).optional(),
    userId: z.string().max(64).optional(),
    status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
    // Requests overlapping this window (1.12.0), e.g. "who is on leave this month".
    from: z.string().refine(isIsoDate).optional(),
    to: z.string().refine(isIsoDate).optional(),
  })
  .refine((q) => !q.from || !q.to || q.to >= q.from, { message: 'to before from', path: ['to'] });

export async function listLeave(user: AuthUser, canManage: boolean, q: z.infer<typeof leaveListSchema>) {
  const f: Record<string, unknown> = canManage ? branchQuery(user, q.branchId) : { userId: user.id };
  if (canManage && q.userId) f.userId = q.userId;
  if (q.status) f.status = q.status;
  if (q.to) f.from = { $lte: q.to };
  if (q.from) f.to = { $gte: q.from };
  const rows = (await LeaveModel.find(f).sort({ createdAt: -1 }).limit(300).lean()) as Lean[];
  const names = await getUsers(rows.map((r) => r.userId));
  return { items: rows.map((l) => leaveView(l, names.get(l.userId)?.name.en ?? '')) };
}

/** The requester withdraws a request nobody has decided yet (1.12.0), e.g. to fix the dates. */
export async function cancelLeave(user: AuthUser, id: string) {
  if (!isOid(id)) throw notFound('leave_request');
  const l = (await LeaveModel.findOne({ _id: id, userId: user.id }).lean()) as Lean | null;
  if (!l) throw notFound('leave_request');
  if (l.status === 'cancelled') return leaveView(l);
  const r = await LeaveModel.updateOne({ _id: id, status: 'pending' }, { $set: { status: 'cancelled', cancelledAt: ctx().clock.now() } });
  if (r.modifiedCount !== 1) throw new AppError('INVALID_STATE', { reason: 'ALREADY_DECIDED' });
  await ctx().bus.emit('leave.cancelled', { leaveId: id, userId: user.id, branchId: l.branchId ?? null });
  return leaveView((await LeaveModel.findById(id).lean()) as Lean);
}

/** The caller's own shift: personal shift, else the branch default (1.12.0). */
export async function myShift(user: AuthUser) {
  const u = await getUser(user.id);
  if (!u) throw notFound('user');
  return resolveShift(u.shiftId, u.branchIds[0] ?? null);
}

export async function decideLeave(actor: AuthUser, id: string, input: { decision: 'approve' | 'reject'; reason?: string | undefined }, meta: RequestMeta) {
  if (!isOid(id)) throw notFound('leave_request');
  const l = (await LeaveModel.findOne({ _id: id, ...branchQuery(actor, undefined) }).lean()) as Lean | null;
  if (!l) throw notFound('leave_request');
  if (l.userId === actor.id) throw businessRule('CANNOT_DECIDE_OWN_LEAVE');
  if (input.decision === 'reject' && (input.reason ?? '').trim().length < 5) throw businessRule('REASON_REQUIRED');
  const status = input.decision === 'approve' ? 'approved' : 'rejected';
  const r = await LeaveModel.updateOne({ _id: id, status: 'pending' }, { $set: { status, decidedBy: actor.id, decidedAt: ctx().clock.now(), decisionReason: input.reason ?? null } });
  if (r.modifiedCount !== 1) throw new AppError('INVALID_STATE', { reason: 'ALREADY_DECIDED' });
  await audit.record({ actor, action: `leave.${status}`, entity: 'leave_request', entityId: id, branchId: l.branchId, after: { from: l.from, to: l.to }, reason: input.reason ?? null, meta });
  // Approved leave changes already-derived days in the range (absence logic).
  if (status === 'approved') {
    const u = await getUser(l.userId);
    if (u) for (let d = l.from; d <= l.to && d <= today(); d = addDays(d, 1)) await recompute(u, d);
  }
  await ctx().bus.emit('leave.decided', { leaveId: id, userId: l.userId, decision: input.decision });
  return leaveView((await LeaveModel.findById(id).lean()) as Lean);
}
