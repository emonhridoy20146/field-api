import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, createTestApp, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { applyAssignments, getByErpId } from '../../src/modules/customers/index.js';
import { setSystem } from '../../src/modules/settings/index.js';
import { summarizeDay, watchdog } from '../../src/modules/location/service.js';
import { LocationPointModel, StopModel, DailySummaryModel } from '../../src/modules/location/models/location.model.js';

let t: TestApp;
let s: Seeded;
let customerId = '';
let visitId = '';
const FS1 = '01700000003';
const DEV = `dev-${FS1}`;
const pin = { lat: 22.7105, lng: 90.3702 }; // customer 100245 in the ERP fixture
const geo = { ...pin, accuracyM: 8 };
const at = (hhmm: string, sec = '00') => `2026-11-15T${hhmm}:${sec}Z`;
const pt = (time: string, lat: number, lng: number, extra: Record<string, unknown> = {}) => ({ t: time, lat, lng, acc: 10, ...extra });
const att = (type: string, time: string) => ({ clientId: randomUUID(), type, at: time, geo });

/** 03:10–03:14 walking towards the customer, 03:15–03:25 standing at the pin, 03:26–03:28 walking away. */
function dayTrack() {
  const points = [];
  for (let i = 0; i < 5; i++) points.push(pt(at(`03:1${i}`), 22.7 + i * 0.0021, 90.36 + i * 0.00204, { act: 'walking', bat: 0.8 }));
  for (let i = 0; i <= 10; i++) points.push(pt(at(`03:${15 + i}`), pin.lat + (i % 2) * 0.00002, pin.lng, { act: 'still' }));
  for (let i = 1; i <= 3; i++) points.push(pt(at(`03:${25 + i}`), pin.lat + i * 0.002, pin.lng, { act: 'walking', bat: 0.7 }));
  return points;
}

beforeAll(async () => {
  t = await createTestApp(); // Sunday 2026-11-15 10:00 Dhaka (04:00Z)
  s = await seedBasics(t);
  await deltaSync();
  customerId = (await getByErpId('100245'))!.id;
  const fs = await as(t, FS1);
  await fs.post('/attendance/events', att('work_in', at('03:00')));
  // A visit recorded while standing at the customer's door, and a collection from a second customer.
  const other = (await getByErpId('100246'))!.id;
  await applyAssignments([
    { customerId, assigneeId: s.fs1.id },
    { customerId: other, assigneeId: s.fs1.id },
  ]);
  const v = await fs.post('/visits', { clientId: randomUUID(), customerId, checkInAt: at('03:18'), outcome: 'partial_paid', geo });
  visitId = v.body.id;
  await fs.post('/collections', { clientId: randomUUID(), customerId: other, amountPoisha: 150000, method: 'cash', recordedAt: at('03:22'), receiptNo: 'BRL01-FS014-261115-0001', geo }, { 'idempotency-key': randomUUID() });
});
afterAll(async () => t.close());

describe('ingest (FR-LOC-001/003/004)', () => {
  it('stores on-duty points and reports each refused point with its reason', async () => {
    const fs = await as(t, FS1);
    const track = dayTrack();
    const r = await fs.post('/location/points', { deviceId: DEV, points: track });
    expect(r.status).toBe(200);
    expectConforms('POST', '/location/points', 200, r.body);
    expect(r.body).toMatchObject({ accepted: track.length, rejected: [] });
    expect(r.body.nextSampling.fastSec).toBe(15);

    const bad = await fs.post('/location/points', {
      deviceId: DEV,
      points: [
        pt(at('02:50'), 22.7, 90.36), // before work-in
        pt(at('03:29'), 22.7166, 90.3702, { acc: 6000 }), // beyond any use (rough points up to 5 km are kept, ADR-041)
        pt(at('03:28'), 22.7165, 90.3702), // already stored
        pt(at('04:10'), 22.7166, 90.3702), // 10 minutes ahead of the server clock
        pt(at('03:30'), 23.2, 90.3702), // ~54 km in two minutes
        pt(at('03:31'), 22.7185, 90.3702),
      ],
    });
    expectConforms('POST', '/location/points', 200, bad.body);
    expect(bad.body.accepted).toBe(1);
    expect(bad.body.rejected).toEqual([
      { index: 0, reason: 'OFF_DUTY' },
      { index: 1, reason: 'LOW_ACCURACY' },
      { index: 2, reason: 'DUPLICATE' },
      { index: 3, reason: 'FUTURE_TIME' },
      { index: 4, reason: 'IMPOSSIBLE_SPEED' },
    ]);
    expect(await LocationPointModel.countDocuments({ 'meta.userId': s.fs1.id })).toBe(track.length + 1);
    // Hard boundary: nothing outside duty hours is ever stored.
    expect(await LocationPointModel.countDocuments({ recordedAt: { $lt: new Date(at('03:00')) } })).toBe(0);
    expect((await fs.post('/location/points', { deviceId: DEV, points: [] })).body.accepted).toBe(0);
  });

  it('refuses everything from someone who has not started work, and pauses during breaks unless the setting allows', async () => {
    const fs2 = await as(t, '01700000004');
    const off = await fs2.post('/location/points', { deviceId: 'dev-01700000004', points: [pt(at('03:20'), 22.7, 90.36)] });
    expect(off.body).toMatchObject({ accepted: 0, rejected: [{ index: 0, reason: 'OFF_DUTY' }] });
    expect(await LocationPointModel.countDocuments({ 'meta.userId': s.fs2.id })).toBe(0);

    const fs = await as(t, FS1);
    await fs.post('/attendance/events', att('break_start', at('03:40')));
    await fs.post('/attendance/events', att('break_end', at('03:45')));
    const paused = await fs.post('/location/points', { deviceId: DEV, points: [pt(at('03:42'), 22.7186, 90.3702), pt(at('03:46'), 22.7187, 90.3702)] });
    expect(paused.body).toMatchObject({ accepted: 1, rejected: [{ index: 0, reason: 'OFF_DUTY' }] });
    await setSystem('location.trackDuringBreak', true);
    const allowed = await fs.post('/location/points', { deviceId: DEV, points: [pt(at('03:43'), 22.7186, 90.3702)] });
    expect(allowed.body.accepted).toBe(1);
    await setSystem('location.trackDuringBreak', false);
  });

  it('validation, device binding, permissions', async () => {
    const fs = await as(t, FS1);
    expect((await fs.post('/location/points', { deviceId: DEV, points: [{ t: 'yesterday', lat: 1, lng: 1, acc: 1 }] })).status).toBe(400);
    expect((await fs.post('/location/points', { deviceId: DEV, points: [pt(at('03:50'), 122.7, 90.36)] })).status).toBe(400);
    expect((await fs.post('/location/points', { deviceId: 'someone-elses-phone', points: [] })).status).toBe(400);
    expect((await fs.post('/location/points', { points: [] })).status).toBe(400);
    const bm = await as(t, '01700000002');
    expect((await bm.post('/location/points', { deviceId: 'dev-01700000002', points: [] })).status).toBe(403);
    expect((await bm.post('/location/heartbeat', {})).status).toBe(403);
    expect((await fs.get('/location/latest')).status).toBe(403);
    expect((await fs.get(`/location/history?userId=${s.fs1.id}&date=2026-11-15`)).status).toBe(403);
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/location/points', payload: { deviceId: DEV, points: [] } })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/location/latest' })).statusCode).toBe(401);
  });
});

describe('heartbeat and latest map (FR-LOC-006/010)', () => {
  it('shows one marker per on-duty staff member in scope, with device state from the heartbeat', async () => {
    const fs = await as(t, FS1);
    const hb = await fs.post('/location/heartbeat', { battery: 0.64, gpsEnabled: true, permission: 'always', appVersion: '1.0.0', pendingPoints: 0, trackingProvider: 'free', trackingProviderFallback: true });
    expect(hb.status).toBe(204);
    expect((await fs.post('/location/heartbeat', { permission: 'sometimes' })).status).toBe(400);

    const bm = await as(t, '01700000002');
    const r = await bm.get('/location/latest');
    expect(r.status).toBe(200);
    expectConforms('GET', '/location/latest', 200, r.body);
    expect(r.body).toHaveLength(1);
    expect(r.body[0]).toMatchObject({ userId: s.fs1.id, name: 'Rakib Hasan', freshness: 'stale', onBreak: false, mock: false, battery: 0.64, trackingProvider: 'free', trackingProviderFallback: true, todayVisits: 1, todayCollectedPoisha: 150000 });
    expect(r.body[0].recordedAt).toBe('2026-11-15T03:46:00.000Z'); // an older point uploaded later does not rewind the marker
    expect(r.body[0].lat).toBeCloseTo(22.7187);

    const sa = await as(t, '01700000001');
    expect((await sa.get(`/location/latest?branchId=${s.branchB}`)).body).toEqual([]);
    expect((await bm.get(`/location/latest?branchId=${s.branchB}`)).body).toEqual([]);
    expect((await (await as(t, '01700000006')).get('/location/latest')).status).toBe(403); // viewer has no map permission by default
  });

  it('mock GPS is stored, marked, and raised in the inbox once per day', async () => {
    const fs = await as(t, FS1);
    const r = await fs.post('/location/points', { deviceId: DEV, points: [pt(at('03:50'), 22.7188, 90.3702, { mock: true }), pt(at('03:51'), 22.7189, 90.3702, { mock: true })] });
    expect(r.body.accepted).toBe(2);
    const bm = await as(t, '01700000002');
    expect((await bm.get('/location/latest')).body[0].mock).toBe(true);
    const inbox = await bm.get('/inbox?type=location.mock');
    expect(inbox.body.items).toHaveLength(1);
    expect(inbox.body.items[0].severity).toBe('high');
  });

  it('watchdog raises "tracking stopped" for staff on duty with no signal', async () => {
    const fs2 = await as(t, '01700000004');
    await fs2.post('/attendance/events', att('work_in', at('03:05')));
    expect(await watchdog()).toBe(1); // fs2 silent for 55 min; fs1 sent a point 9 min ago
    expect(await watchdog()).toBe(1);
    const bm = await as(t, '01700000002');
    const inbox = await bm.get('/inbox?type=location.tracking_lost');
    expect(inbox.body.items).toHaveLength(1); // one item per person and day
    await fs2.post('/location/heartbeat', { gpsEnabled: false });
    expect(await watchdog()).toBe(0);
  });

  it('a staff member on duty shows at the work-in position until the first point, and rough indoor points still move the marker (ADR-041)', async () => {
    const bm = await as(t, '01700000002');
    const mapOf = async () => ((await bm.get('/location/latest')).body as { userId: string }[]).find((m) => m.userId === s.fs2.id) as Record<string, unknown> | undefined;
    const before = await mapOf();
    expect(before).toMatchObject({ source: 'attendance', lat: pin.lat, lng: pin.lng, accuracyM: 8, recordedAt: '2026-11-15T03:05:00.000Z', lowAccuracy: false, freshness: 'lost' });
    expectConforms('GET', '/location/latest', 200, [before]);

    const fs2 = await as(t, '01700000004');
    const rough = await fs2.post('/location/points', { deviceId: 'dev-01700000004', points: [pt(at('03:58'), 22.712, 90.371, { acc: 300 })] });
    expect(rough.body).toMatchObject({ accepted: 1, rejected: [] });
    expect(await mapOf()).toMatchObject({ source: 'track', lat: 22.712, accuracyM: 300, lowAccuracy: true, freshness: 'fresh' });
    // a good point replaces it; a rough one right after does not take the marker back
    await fs2.post('/location/points', { deviceId: 'dev-01700000004', points: [pt(at('03:59'), 22.7121, 90.3711, { acc: 12 })] });
    await fs2.post('/location/points', { deviceId: 'dev-01700000004', points: [pt(at('03:59', '30'), 22.7125, 90.3713, { acc: 400 })] });
    expect(await mapOf()).toMatchObject({ lat: 22.7121, accuracyM: 12, lowAccuracy: false });
    // rough points never reach the route
    const h = await bm.get(`/location/history?userId=${s.fs2.id}&date=2026-11-15`);
    expect(await LocationPointModel.countDocuments({ 'meta.userId': s.fs2.id })).toBe(3);
    expect(h.body.summary.distanceKm).toBe(0);
  });
});

describe('history, stops, summary (FR-LOC-007/008/012)', () => {
  it('returns the route with the stop matched to the customer pin', async () => {
    const bm = await as(t, '01700000002');
    const r = await bm.get(`/location/history?userId=${s.fs1.id}&date=2026-11-15`);
    expect(r.status).toBe(200);
    expectConforms('GET', '/location/history', 200, r.body);
    expect(r.body.polyline.length).toBeGreaterThan(10);
    expect(r.body.stops).toHaveLength(2);
    expect(r.body.stops[1]).toMatchObject({ start: '2026-11-15T03:31:00.000Z', end: '2026-11-15T03:51:00.000Z', customerId: null, customerName: null, distanceToPinM: null }); // ~900 m from any pin
    expect(r.body.stops[0]).toMatchObject({ start: '2026-11-15T03:15:00.000Z', end: '2026-11-15T03:25:00.000Z', dwellMin: 10, customerId, visitId }); // the stop is explained by the visit recorded during it
    expect(r.body.events.map((e: { kind: string; at: string }) => [e.kind, e.at])).toEqual([['visit', '2026-11-15T03:18:00.000Z'], ['collection', '2026-11-15T03:22:00.000Z']]);
    expect(r.body.events[0]).toMatchObject({ refId: visitId, actor: { id: s.fs1.id }, data: { customerId, outcome: 'partial_paid' } });
    expect(r.body.events[1].data).toMatchObject({ amountPoisha: 150000, method: 'cash' });
    expect(r.body.events[1].summary.en).toContain('Collected ৳1,500');
    expect(r.body.stops[0].distanceToPinM).toBeLessThan(5);
    expect(r.body.segments.map((x: { kind: string }) => x.kind)).toEqual(['moving', 'gap', 'moving']); // 03:31 → 03:43 is a gap
    expect(r.body.summary).toMatchObject({ stopsCount: 2, customerStops: 1, stoppedMin: 30, gapsMin: 12, mockPoints: 2 });
    expect(r.body.summary.distanceKm).toBeGreaterThan(1.5);

    const st = await bm.get(`/location/stops?userId=${s.fs1.id}&date=2026-11-15`);
    expect(st.status).toBe(200);
    expectConforms('GET', '/location/stops', 200, st.body);
    expect(st.body).toEqual(r.body.stops);

    const empty = await bm.get(`/location/history?userId=${s.fs1.id}&date=2026-11-14`);
    expect(empty.body).toMatchObject({ polyline: '', stops: [], segments: [] });
  });

  it('money and visit details follow their own permissions, not the map permission', async () => {
    const sa = await as(t, '01700000001');
    await sa.put(`/rbac/overrides/branch/${s.branchA}`, { role: 'branch_manager', changes: [{ key: 'collection.view', effect: 'deny' }], reason: 'Test: map without money' });
    const bm = await as(t, '01700000002');
    const h = await bm.get(`/location/history?userId=${s.fs1.id}&date=2026-11-15`);
    expect(h.body.events.map((e: { kind: string }) => e.kind)).toEqual(['visit']);
    const l = (await bm.get('/location/latest')).body.find((m: { userId: string }) => m.userId === s.fs1.id);
    expect(l.todayVisits).toBe(1);
    expect(l).not.toHaveProperty('todayCollectedPoisha');
    await sa.put(`/rbac/overrides/branch/${s.branchA}`, { role: 'branch_manager', changes: [{ key: 'collection.view', effect: 'inherit' }], reason: 'Test: restore' });
    expect((await (await as(t, '01700000002')).get(`/location/history?userId=${s.fs1.id}&date=2026-11-15`)).body.events).toHaveLength(2);
  });

  it('scope and input checks', async () => {
    const bm = await as(t, '01700000002');
    expect((await bm.get(`/location/history?userId=${s.fsB.id}&date=2026-11-15`)).status).toBe(404); // other branch
    expect((await bm.get(`/location/stops?userId=${'a'.repeat(24)}&date=2026-11-15`)).status).toBe(404);
    expect((await bm.get(`/location/history?userId=${s.fs1.id}&date=2026-11-16`)).status).toBe(400); // future
    expect((await bm.get(`/location/history?userId=${s.fs1.id}&date=15-11-2026`)).status).toBe(400);
    expect((await bm.get('/location/history?date=2026-11-15')).status).toBe(400);
    const sa = await as(t, '01700000001');
    expect((await sa.get(`/location/history?userId=${s.fsB.id}&date=2026-11-15`)).status).toBe(200);
  });

  it('nightly job keeps stops and summary, which still answer after raw points expire', async () => {
    expect(await summarizeDay('2026-11-15')).toBe(2); // fs1 and fs2 (who sent a good point in the ADR-041 test)
    expect(await summarizeDay('2026-11-15')).toBe(2); // re-run replaces, never duplicates
    expect(await StopModel.countDocuments({ userId: s.fs1.id })).toBe(2);
    const sum = await DailySummaryModel.find({ userId: s.fs1.id }).lean();
    expect(sum).toHaveLength(1);
    expect(sum[0]).toMatchObject({ businessDate: '2026-11-15', stopsCount: 2, customerStops: 1 });

    await LocationPointModel.deleteMany({}); // what the time-series TTL does after the retention period
    const bm = await as(t, '01700000002');
    const r = await bm.get(`/location/history?userId=${s.fs1.id}&date=2026-11-15`);
    expectConforms('GET', '/location/history', 200, r.body);
    expect(r.body.polyline).toBe('');
    expect(r.body.stops).toHaveLength(2);
    expect(r.body.stops[0]).toMatchObject({ customerId, visitId });
    expect(r.body.events).toHaveLength(2); // visits and collections outlive the raw points
    expect(r.body.summary.stopsCount).toBe(2);
    expect((await bm.get(`/location/stops?userId=${s.fs1.id}&date=2026-11-15`)).body).toHaveLength(2);
  });
});
