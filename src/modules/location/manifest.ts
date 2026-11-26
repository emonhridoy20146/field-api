import type { ModuleManifest } from '../../core/module/types.js';
import { indexMigration, type Migration } from '../../core/db/migrations.js';
import { locationRoutes } from './routes.js';
import { DEFAULT_SAMPLING, summarizeDay, watchdog } from './service.js';

/** Time-series collection for raw points (06-data-model §5); retention is adjusted nightly from the setting. */
const createPoints: Migration = {
  id: '20261115-0001-location-points-timeseries',
  async up(d) {
    const exists = await d.listCollections({ name: 'location_points' }).hasNext();
    if (!exists) await d.createCollection('location_points', { timeseries: { timeField: 'recordedAt', metaField: 'meta', granularity: 'seconds' }, expireAfterSeconds: 90 * 86_400 });
    await d.collection('location_points').createIndex({ 'meta.userId': 1, recordedAt: 1 });
  },
};

export const manifest: ModuleManifest = {
  name: 'location',
  version: '1.0.0',
  description: 'Duty-hours location: ingest with filters, tracking token, heartbeat, latest map, route history, stops, daily summary (FR-LOC-001..013)',
  featureFlag: { key: 'module.location', default: false, description: 'Duty-hours location tracking', owner: 'field-api' },
  dependsOn: ['settings', 'users', 'rbac', 'attendance', 'customers', 'visits', 'collections', 'auth', 'devices'],
  permissions: [
    { key: 'location.view', description: { en: 'Latest location map', bn: 'সর্বশেষ অবস্থানের ম্যাপ' }, defaults: { super_admin: true, area_manager: true, branch_manager: true } },
    { key: 'location.history.view', description: { en: 'Route history and stops', bn: 'রুটের ইতিহাস ও বিরতি' }, defaults: { super_admin: true, area_manager: true, branch_manager: true } },
  ],
  routes: locationRoutes,
  events: { emits: ['location.mock_detected', 'location.tracking_lost'], consumes: [] },
  settings: [
    { key: 'location.sampling', type: 'json', default: DEFAULT_SAMPLING, branchOverridable: true, exposeToApp: true, description: 'FR-LOC-002 sampling intervals sent to the app' },
    { key: 'location.trackDuringBreak', type: 'bool', default: false, branchOverridable: true, exposeToApp: true, description: 'OD-05: accept points during breaks (default paused)' },
    { key: 'location.maxAccuracyM', type: 'int', default: 50, exposeToApp: true, description: 'FR-LOC-003 points less accurate than this are kept for the live map only (flagged lowAccuracy), not the route (ADR-041)' },
    { key: 'location.maxSpeedKmh', type: 'int', default: 120, description: 'FR-LOC-003 discard points implying more than this speed' },
    { key: 'location.retentionDays', type: 'int', default: 90, description: 'FR-LOC-009 raw point retention (7–730 days)' },
    { key: 'location.gapMin', type: 'int', default: 10, description: 'No point for longer than this is shown as a gap' },
    { key: 'location.trackingTokenTtlHours', type: 'int', default: 24, description: 'FR-LOC-013 (1.49.0, ADR-067) lifetime of the tracking token of the native location service, 1–168 hours' },
    { key: 'location.lostAfterMin', type: 'int', default: 30, description: 'FR-LOC-010 no point and no heartbeat for this long while on duty raises "tracking stopped"' },
    { key: 'stops.radiusM', type: 'int', default: 60, branchOverridable: true, exposeToApp: true, description: 'FR-LOC-008 stop radius' },
    { key: 'stops.minDwellMin', type: 'int', default: 5, branchOverridable: true, exposeToApp: true, description: 'FR-LOC-008 minimum dwell' },
  ],
  jobs: [
    { name: 'location.summarize', schedule: '0 1 * * *', handler: async () => void (await summarizeDay()) },
    { name: 'location.watchdog', schedule: '*/10 * * * *', handler: async () => void (await watchdog()) },
  ],
  inboxTypes: [
    { type: 'location.mock', severity: 'high' },
    { type: 'location.tracking_lost', severity: 'medium' },
  ],
  migrations: [
    createPoints,
    indexMigration('20261115-0002-location-indexes', [
      { collection: 'location_latest', key: { branchId: 1 } },
      { collection: 'location_heartbeats', key: { userId: 1, at: -1 } },
      { collection: 'location_heartbeats', key: { at: 1 }, options: { expireAfterSeconds: 30 * 86_400 } },
      { collection: 'location_stops', key: { userId: 1, businessDate: 1 } },
      { collection: 'location_stops', key: { end: 1 }, options: { expireAfterSeconds: 365 * 86_400 } },
      { collection: 'location_daily_summaries', key: { userId: 1, businessDate: 1 }, options: { unique: true } },
      { collection: 'location_daily_summaries', key: { day: 1 }, options: { expireAfterSeconds: 730 * 86_400 } },
    ]),
  ],
};
