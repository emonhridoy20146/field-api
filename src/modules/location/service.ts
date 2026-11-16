import { z } from 'zod';
import { ctx } from '../../core/context/index.js';
import { AppError, notFound } from '../../core/errors/index.js';
import { db, isOid, type LeanDoc, type LooseObject } from '../../core/db/index.js';
import { encodePolyline, simplify } from '../../core/geo/index.js';
import { addDays, businessDate, endOfBusinessDay, isIsoDate, startOfBusinessDay } from '../../core/time/index.js';
import { canSeeBranch, type AuthUser } from '../../core/security/types.js';
import { getSetting } from '../settings/index.js';
import { getUser, listByRole, type UserView } from '../users/index.js';
import { allOnDutyNow, dutyStateAt, dutyWindows, onDutyNow } from '../attendance/index.js';
import { getCustomerRefs, nearestCustomer } from '../customers/index.js';
import { can } from '../rbac/index.js';
import { visitCountsOfDay, visitsOfUserDay } from '../visits/index.js';
import { collectedOfDay, collectionsOfUserDay } from '../collections/index.js';
import { formatBdt } from '../../core/money/index.js';
import { filterPoints, type RawPoint } from './domain/filter.js';
import { detectStops, freshness, segments, summarize, type TrackPoint } from './domain/track.js';
import { DailySummaryModel, HeartbeatModel, LocationLatestModel, LocationPointModel, StopModel } from './models/location.model.js';

const now = () => ctx().clock.now();
const today = () => businessDate(now());

export const DEFAULT_SAMPLING = { fastSec: 15, slowSec: 45, stillSec: 180, distanceFilterM: 25, maxAccuracyM: 50 };

const pointSchema = z.object({
  t: z.string().datetime({ offset: true }),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  acc: z.number().min(0).max(100_000),
  spd: z.number().min(0).max(1000).optional(),
  hdg: z.number().min(0).max(360).optional(),
  alt: z.number().min(-1000).max(20_000).optional(),
  act: z.enum(['still', 'walking', 'on_bicycle', 'in_vehicle', 'unknown']).optional(),
  bat: z.number().min(0).max(1).optional(),
  chg: z.boolean().optional(),
  mock: z.boolean().optional(),
});
export const ingestSchema = z.object({ deviceId: z.string().min(1).max(100), points: z.array(pointSchema).max(500) });

type Incoming = RawPoint & { src: z.infer<typeof pointSchema> };

function checkDevice(user: AuthUser, deviceId: string) {
  if (user.deviceId && deviceId !== user.deviceId) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'deviceId', message: 'does not match the signed-in device' }] });
}

/**
 * FR-LOC-001/003/004: store only points taken on duty (and outside breaks unless the setting allows
 * them). Bad points are reported per index, never stored; the batch itself always answers 200 so the
 * app can drop what was refused and keep going.
 */
export async function ingest(user: AuthUser, input: z.infer<typeof ingestSchema>) {
  checkDevice(user, input.deviceId);
  const branchId = user.branchIds[0] ?? null;
  const sampling = { ...DEFAULT_SAMPLING, ...((await getSetting<Partial<typeof DEFAULT_SAMPLING>>('location.sampling', branchId)) ?? {}) };
  if (!input.points.length) return { accepted: 0, rejected: [], nextSampling: sampling };

  const points: Incoming[] = input.points.map((p) => ({ t: new Date(p.t), lat: p.lat, lng: p.lng, acc: p.acc, src: p }));
  const times = points.map((p) => p.t.getTime());
  const from = new Date(Math.min(...times));
  const to = new Date(Math.max(...times));
  const windows = await dutyWindows(user.id, from, to);
  const duringBreak = (await getSetting<boolean>('location.trackDuringBreak', branchId)) ?? false;
  const stored = (await LocationPointModel.find({ 'meta.userId': user.id, recordedAt: { $gte: from, $lte: to } }).select({ recordedAt: 1, lat: 1, lng: 1, accuracyM: 1 }).lean()) as LeanDoc[];
  const before = (await LocationPointModel.findOne({ 'meta.userId': user.id, recordedAt: { $lt: from } }).sort({ recordedAt: -1 }).lean()) as LeanDoc | null;

  const r = filterPoints(points, {
    now: now(),
    maxAccuracyM: (await getSetting<number>('location.maxAccuracyM', branchId)) ?? 50,
    maxSpeedKmh: (await getSetting<number>('location.maxSpeedKmh', branchId)) ?? 120,
    futureToleranceMs: 120_000,
    onDuty: (at) => {
      const s = dutyStateAt(windows, at);
      return s === 'on_duty' || (s === 'on_break' && duringBreak);
    },
    known: stored.map((s) => ({ t: s.recordedAt as Date, lat: s.lat as number, lng: s.lng as number, acc: s.accuracyM as number })),
    previous: before ? { t: before.recordedAt, lat: before.lat, lng: before.lng, acc: before.accuracyM } : null,
  });

  if (r.accepted.length) {
    const receivedAt = now();
    await LocationPointModel.insertMany(
      r.accepted.map((p) => ({
        recordedAt: p.t,
        meta: { userId: user.id, branchId, deviceId: input.deviceId },
        lat: p.lat,
        lng: p.lng,
        accuracyM: p.acc,
        speedMps: p.src.spd ?? null,
        headingDeg: p.src.hdg ?? null,
        altitudeM: p.src.alt ?? null,
        activity: p.src.act ?? 'unknown',
        battery: p.src.bat ?? null,
        charging: p.src.chg ?? null,
        mock: p.src.mock ?? false,
        receivedAt,
      })),
    );
    const newest = r.accepted[r.accepted.length - 1]!;
    // Only move the marker forward: a late upload of old points must not rewind it.
    await LocationLatestModel.updateOne(
      { _id: user.id, $or: [{ recordedAt: null }, { recordedAt: { $lt: newest.t } }] },
      { $set: { branchId, point: { type: 'Point', coordinates: [newest.lng, newest.lat] }, accuracyM: newest.acc, recordedAt: newest.t, activity: newest.src.act ?? 'unknown', mock: newest.src.mock ?? false, ...(newest.src.bat !== undefined ? { battery: newest.src.bat } : {}) } },
      { upsert: true },
    ).catch((e: { code?: number }) => {
      if (e.code !== 11000) throw e; // upsert raced with a newer point already stored
    });
    const mockDays = new Set(r.accepted.filter((p) => p.src.mock).map((p) => businessDate(p.t)));
    for (const d of mockDays) await ctx().bus.emit('location.mock_detected', { userId: user.id, branchId, businessDate: d });
  }
  return { accepted: r.accepted.length, rejected: r.rejected, nextSampling: sampling };
}

export const heartbeatSchema = z.object({
  battery: z.number().min(0).max(1).optional(),
  charging: z.boolean().optional(),
  gpsEnabled: z.boolean().optional(),
  permission: z.enum(['always', 'while_in_use', 'denied']).optional(),
  bgRestricted: z.boolean().optional(),
  appVersion: z.string().max(30).optional(),
  pendingPoints: z.number().int().min(0).max(1_000_000).optional(),
  pendingMutations: z.number().int().min(0).max(1_000_000).optional(),
  trackingProvider: z.enum(['free', 'paid']).optional(),
  trackingProviderFallback: z.boolean().optional(),
});

/** FR-LOC-010: device state without a position. */
export async function heartbeat(user: AuthUser, input: z.infer<typeof heartbeatSchema>): Promise<void> {
  const at = now();
  await HeartbeatModel.create({ userId: user.id, at, ...input });
  const set: Record<string, unknown> = { heartbeatAt: at, branchId: user.branchIds[0] ?? null };
  for (const k of ['battery', 'gpsEnabled', 'permission', 'bgRestricted', 'appVersion', 'trackingProvider', 'trackingProviderFallback'] as const) if (input[k] !== undefined) set[k] = input[k];
  await LocationLatestModel.updateOne({ _id: user.id }, { $set: set }, { upsert: true });
}

/** FR-LOC-006: one marker per staff member who is on duty now and has sent a point today. */
export async function latest(user: AuthUser, branchId?: string) {
  if (branchId && !canSeeBranch(user, branchId)) return [];
  const onDuty = await onDutyNow(user, branchId);
  if (!onDuty.size) return [];
  const rows = (await LocationLatestModel.find({ _id: { $in: [...onDuty.keys()] }, recordedAt: { $gte: startOfBusinessDay(today()) } }).lean()) as LooseObject[];
  const at = now().getTime();
  // Today's activity on the marker, each part only for callers who may see that data anyway.
  const ids = rows.map((r) => r._id as string);
  const visits = (await can(user, 'visit.view')) ? await visitCountsOfDay(ids, today()) : null;
  const collected = (await can(user, 'collection.view')) ? await collectedOfDay(ids, today()) : null;
  return rows.map((r) => {
    const d = onDuty.get(r._id as string)!;
    return {
      userId: r._id as string,
      name: d.name,
      lat: r.point.coordinates[1] as number,
      lng: r.point.coordinates[0] as number,
      accuracyM: r.accuracyM as number,
      recordedAt: (r.recordedAt as Date).toISOString(),
      freshness: freshness(at - (r.recordedAt as Date).getTime()),
      ...(r.battery !== null && r.battery !== undefined ? { battery: r.battery as number } : {}),
      onBreak: d.onBreak,
      mock: !!r.mock,
      activity: (r.activity as string) ?? 'unknown',
      ...(visits ? { todayVisits: visits.get(r._id as string) ?? 0 } : {}),
      ...(collected ? { todayCollectedPoisha: collected.get(r._id as string) ?? 0 } : {}),
      ...(r.trackingProvider ? { trackingProvider: r.trackingProvider as string } : {}),
      ...(r.trackingProviderFallback !== null && r.trackingProviderFallback !== undefined ? { trackingProviderFallback: r.trackingProviderFallback as boolean } : {}),
    };
  });
}

// ---------------- history, stops, summary (FR-LOC-007/008/012) ----------------

async function staffInScope(user: AuthUser, userId: string): Promise<UserView> {
  const u = isOid(userId) ? await getUser(userId) : null;
  if (!u || !u.branchIds.some((b) => canSeeBranch(user, b))) throw notFound('user');
  return u;
}

async function trackOf(userId: string, date: string): Promise<TrackPoint[]> {
  const rows = (await LocationPointModel.find({ 'meta.userId': userId, recordedAt: { $gte: startOfBusinessDay(date), $lte: endOfBusinessDay(date) } }).sort({ recordedAt: 1 }).lean()) as LeanDoc[];
  return rows.map((r) => ({ t: r.recordedAt as Date, lat: r.lat as number, lng: r.lng as number, mock: !!r.mock }));
}

interface StopView {
  start: string;
  end: string;
  dwellMin: number;
  lat: number;
  lng: number;
  customerId: string | null;
  customerName: string | null;
  distanceToPinM: number | null;
  visitId: string | null;
}

const VISIT_SLACK_MS = 5 * 60_000;

async function analyse(u: UserView, date: string) {
  const branchId = u.branchIds[0] ?? null;
  const radiusM = (await getSetting<number>('stops.radiusM', branchId)) ?? 60;
  const minDwell = (await getSetting<number>('stops.minDwellMin', branchId)) ?? 5;
  const gapMin = (await getSetting<number>('location.gapMin', branchId)) ?? 10;
  const track = await trackOf(u.id, date);
  const visits = track.length ? await visitsOfUserDay(u.id, date) : [];
  const stops: (StopView & { pointsCount: number })[] = [];
  for (const s of detectStops(track, radiusM, minDwell)) {
    const c = branchId ? await nearestCustomer(branchId, s, radiusM) : null;
    // A customer stop is "explained" by a visit to that customer recorded during the stop (5 min either side).
    const v = c ? visits.find((x) => x.customerId === c.id && x.checkInAt.getTime() >= s.start.getTime() - VISIT_SLACK_MS && x.checkInAt.getTime() <= s.end.getTime() + VISIT_SLACK_MS) : undefined;
    stops.push({ start: s.start.toISOString(), end: s.end.toISOString(), dwellMin: s.dwellMin, lat: s.lat, lng: s.lng, customerId: c?.id ?? null, customerName: c ? c.name.bn || c.name.en : null, distanceToPinM: c?.distanceM ?? null, visitId: v?.id ?? null, pointsCount: s.pointsCount });
  }
  return { track, stops, gapMin, summary: summarize(track, stops, gapMin) };
}

const stopOut = (s: StopView): StopView => ({ start: s.start, end: s.end, dwellMin: s.dwellMin, lat: s.lat, lng: s.lng, customerId: s.customerId, customerName: s.customerName, distanceToPinM: s.distanceToPinM, visitId: s.visitId });

/** Stored results for days whose raw points have aged out (stops 12 months, summaries 24 months). */
async function stored(userId: string, date: string) {
  const stops = (await StopModel.find({ userId, businessDate: date }).sort({ start: 1 }).lean()) as LeanDoc[];
  const sum = (await DailySummaryModel.findOne({ userId, businessDate: date }).lean()) as LeanDoc | null;
  return {
    stops: stops.map((s) => stopOut({ start: (s.start as Date).toISOString(), end: (s.end as Date).toISOString(), dwellMin: s.dwellMin, lat: s.lat, lng: s.lng, customerId: s.customerId ?? null, customerName: s.customerName ?? null, distanceToPinM: s.distanceToPinM ?? null, visitId: s.visitId ?? null })),
    summary: sum ? { distanceKm: sum.distanceKm, movingMin: sum.movingMin, stoppedMin: sum.stoppedMin, stopsCount: sum.stopsCount, customerStops: sum.customerStops, gapsMin: sum.gapsMin, mockPoints: sum.mockPoints } : null,
  };
}

function checkDate(date: string) {
  if (!isIsoDate(date) || date > today()) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'date', message: 'today or earlier (YYYY-MM-DD)' }] });
}

/** Visits and collections of the day as timeline items for the map (FR-LOC-007), limited to what the caller may view. */
async function dayEvents(user: AuthUser, u: UserView, date: string) {
  const visits = (await can(user, 'visit.view')) ? await visitsOfUserDay(u.id, date) : [];
  const collections = (await can(user, 'collection.view')) ? await collectionsOfUserDay(u.id, date) : [];
  const refs = await getCustomerRefs([...visits.map((v) => v.customerId), ...collections.map((c) => c.customerId)]);
  const actor = { id: u.id, name: u.name.en || u.name.bn };
  const who = (id: string, l: 'bn' | 'en') => {
    const n = refs.get(id)?.name;
    return n ? (l === 'bn' ? n.bn || n.en : n.en || n.bn) : '';
  };
  const items = [
    ...visits.map((v) => ({ kind: 'visit', at: v.checkInAt, actor, summary: { bn: `ভিজিট: ${who(v.customerId, 'bn')}`, en: `Visit: ${who(v.customerId, 'en')}` }, refId: v.id, data: { customerId: v.customerId, outcome: v.outcome, lat: v.lat, lng: v.lng } })),
    ...collections.map((c) => ({ kind: 'collection', at: c.recordedAt, actor, summary: { bn: `আদায় ${formatBdt(c.amountPoisha, 'bn')}: ${who(c.customerId, 'bn')}`, en: `Collected ${formatBdt(c.amountPoisha)}: ${who(c.customerId, 'en')}` }, refId: c.id, data: { customerId: c.customerId, amountPoisha: c.amountPoisha, method: c.method, receiptNo: c.receiptNo, lat: c.lat, lng: c.lng } })),
  ];
  return items.sort((a, b) => a.at.getTime() - b.at.getTime()).map((i) => ({ ...i, at: i.at.toISOString() }));
}

export async function history(user: AuthUser, q: { userId: string; date: string; simplify: number }) {
  checkDate(q.date);
  const u = await staffInScope(user, q.userId);
  const a = await analyse(u, q.date);
  const events = await dayEvents(user, u, q.date);
  if (!a.track.length) {
    const old = await stored(u.id, q.date);
    return { polyline: '', segments: [], stops: old.stops, events, summary: old.summary ?? a.summary };
  }
  return {
    polyline: encodePolyline(simplify(a.track, q.simplify)),
    segments: segments(a.track, a.gapMin).map((s) => ({ from: s.from.toISOString(), to: s.to.toISOString(), kind: s.kind })),
    stops: a.stops.map(stopOut),
    events,
    summary: a.summary,
  };
}

export async function stops(user: AuthUser, q: { userId: string; date: string }) {
  checkDate(q.date);
  const u = await staffInScope(user, q.userId);
  const a = await analyse(u, q.date);
  return a.track.length ? a.stops.map(stopOut) : (await stored(u.id, q.date)).stops;
}

// ---------------- jobs ----------------

/** Nightly: keep yesterday's stops and summary beyond the raw-point retention, and apply the retention setting. */
export async function summarizeDay(date = addDays(today(), -1)): Promise<number> {
  let n = 0;
  for (const u of await listByRole(['field_staff'])) {
    const a = await analyse(u, date);
    if (!a.track.length) continue;
    const branchId = u.branchIds[0] ?? null;
    await StopModel.deleteMany({ userId: u.id, businessDate: date });
    if (a.stops.length) await StopModel.insertMany(a.stops.map((s) => ({ userId: u.id, branchId, businessDate: date, start: new Date(s.start), end: new Date(s.end), dwellMin: s.dwellMin, lat: s.lat, lng: s.lng, customerId: s.customerId, customerName: s.customerName, distanceToPinM: s.distanceToPinM, visitId: s.visitId, pointsCount: s.pointsCount })));
    await DailySummaryModel.updateOne({ userId: u.id, businessDate: date }, { $set: { ...a.summary, branchId, day: startOfBusinessDay(date), firstPointAt: a.track[0]!.t, lastPointAt: a.track[a.track.length - 1]!.t } }, { upsert: true });
    n++;
  }
  await applyRetention();
  return n;
}

/** FR-LOC-009: raw points expire after `location.retentionDays` (time-series TTL, changed with collMod). */
export async function applyRetention(): Promise<void> {
  const days = Math.min(730, Math.max(7, (await getSetting<number>('location.retentionDays')) ?? 90));
  await db().command({ collMod: 'location_points', expireAfterSeconds: days * 86_400 });
}

/**
 * FR-LOC-010: on duty (not on break) for a while but neither a point nor a heartbeat for
 * `location.lostAfterMin` → "tracking stopped". The inbox keeps one item per staff member and day.
 */
export async function watchdog(): Promise<number> {
  const at = now();
  const lostAfterMs = ((await getSetting<number>('location.lostAfterMin')) ?? 30) * 60_000;
  let n = 0;
  for (const s of await allOnDutyNow()) {
    if (s.onBreak) continue;
    const span = (await dutyWindows(s.userId, at, at)).duty.find((d) => d.start <= at && d.end >= at);
    if (!span || at.getTime() - span.start.getTime() < lostAfterMs) continue;
    const l = (await LocationLatestModel.findById(s.userId).lean()) as LeanDoc | null;
    const lastSignal = Math.max(l?.recordedAt ? (l.recordedAt as Date).getTime() : 0, l?.heartbeatAt ? (l.heartbeatAt as Date).getTime() : 0);
    if (at.getTime() - lastSignal < lostAfterMs) continue;
    await ctx().bus.emit('location.tracking_lost', { userId: s.userId, branchId: s.branchId, businessDate: businessDate(at) });
    n++;
  }
  return n;
}

/**
 * Distance and time in the field per staff member (FR-LOC-012, FR-REP-001). Closed days come from the
 * stored summaries; today has none yet, so it is analysed live.
 */
export async function fieldStatsByUser(userIds: string[], from: string, to: string) {
  const out = new Map<string, { distanceKm: number; fieldMin: number }>();
  const add = (id: string, km: number, min: number) => {
    const d = out.get(id) ?? { distanceKm: 0, fieldMin: 0 };
    d.distanceKm = Math.round((d.distanceKm + km) * 100) / 100;
    d.fieldMin += min;
    out.set(id, d);
  };
  const t = today();
  const rows = (await DailySummaryModel.find({ userId: { $in: userIds }, businessDate: { $gte: from, $lte: to, $ne: t } }).lean()) as LeanDoc[];
  for (const r of rows) add(r.userId, r.distanceKm, r.movingMin + r.stoppedMin);
  if (from <= t && t <= to)
    for (const id of userIds) {
      const u = await getUser(id);
      if (!u) continue;
      const a = await analyse(u, t);
      if (a.track.length) add(id, a.summary.distanceKm, a.summary.movingMin + a.summary.stoppedMin);
    }
  return out;
}
