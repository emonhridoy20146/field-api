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
import { autoCloseAt, deriveDay, type DayEvent, type DayKind, type EventType } from './domain/day.js';
import { AttendanceDayModel, AttendanceEventModel, LeaveModel } from './models/attendance.model.js';
import { weekday } from '../../core/time/index.js';

type Lean = LeanDoc;
const today = () => businessDate(ctx().clock.now());

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
  const r = deriveDay({ events, shiftStart: dhakaInstant(date, shift.start), shiftEnd, lateGraceMin: shift.lateGraceMin, maxBreakMin: shift.maxBreakMin, kind: await kindOf(user.id, date, shift, branchId), now, closed });
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
  if (input.type === 'work_in' && !input.selfieMediaId && (await getSetting<boolean>('attendance.selfieRequired', u.branchIds[0] ?? null))) flags.push('no_selfie');
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
      selfieMediaId: input.selfieMediaId ?? null,
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

export async function myToday(user: AuthUser) {
  const u = await getUser(user.id);
  if (!u) throw notFound('user');
  return recompute(u, today());
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
      out.push(hit && hit.closed ? dayView(s.id, d, hit) : await recompute(s, d));
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
  for (const d of all) {
    const r = rows.get(d.userId) ?? { userId: d.userId, userName: names.get(d.userId)?.name.en ?? '', present: 0, late: 0, absent: 0, leave: 0, holiday: 0, weeklyOff: 0, lateMin: 0, breakMin: 0, dutyMin: 0, overBreakDays: 0 };
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
  type: l.type,
  from: l.from,
  to: l.to,
  reason: l.reason ?? '',
  status: l.status,
  ...(l.decidedBy ? { decidedBy: l.decidedBy, decidedAt: (l.decidedAt as Date).toISOString() } : {}),
  createdAt: (l.createdAt as Date).toISOString(),
});

export async function requestLeave(user: AuthUser, input: z.infer<typeof leaveSchema>) {
  if (input.to > addDays(input.from, 30)) throw businessRule('LEAVE_TOO_LONG', { maxDays: 31 });
  if (await LeaveModel.exists({ userId: user.id, status: { $in: ['pending', 'approved'] }, from: { $lte: input.to }, to: { $gte: input.from } })) throw new AppError('INVALID_STATE', { reason: 'LEAVE_OVERLAPS' });
  const l = await LeaveModel.create({ ...input, reason: input.reason ?? null, userId: user.id, branchId: user.branchIds[0] ?? null, createdAt: ctx().clock.now() });
  await ctx().bus.emit('leave.requested', { leaveId: l._id.toHexString(), userId: user.id, branchId: user.branchIds[0] ?? null });
  return leaveView(l.toObject() as Lean);
}

export async function listLeave(user: AuthUser, canManage: boolean, q: { status?: string | undefined; branchId?: string | undefined }) {
  const f: Record<string, unknown> = canManage ? branchQuery(user, q.branchId) : { userId: user.id };
  if (q.status) f.status = q.status;
  const rows = (await LeaveModel.find(f).sort({ createdAt: -1 }).limit(300).lean()) as Lean[];
  const names = await getUsers(rows.map((r) => r.userId));
  return { items: rows.map((l) => leaveView(l, names.get(l.userId)?.name.en ?? '')) };
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
