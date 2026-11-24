import type { ModuleManifest } from '../../core/module/types.js';
import { indexMigration } from '../../core/db/migrations.js';
import { settingsRoutes } from './routes.js';
import { defaultShiftSchema } from './domain/shift.js';

export const manifest: ModuleManifest = {
  name: 'settings',
  version: '1.0.0',
  core: true,
  description: 'Typed org/branch settings, holidays and shifts (FR-SET-*)',
  dependsOn: ['audit'],
  permissions: [
    { key: 'settings.manage', description: { en: 'Org settings, duty hours, thresholds, holidays', bn: 'সেটিংস, ডিউটি সময়, ছুটি' }, defaults: { super_admin: true }, neverFor: ['area_manager'] },
  ],
  routes: settingsRoutes,
  events: { emits: ['settings.changed'], consumes: [] },
  settings: [
    { key: 'app.minVersion', type: 'string', default: '1.0.0', description: 'FR-AUTH-009 version gate' },
    { key: 'app.latestVersion', type: 'string', default: '1.0.0' },
    { key: 'app.storeUrl', type: 'string', default: '' },
    { key: 'app.killSwitch', type: 'bool', default: false },
    { key: 'privacy.noticeVersion', type: 'string', default: '2026-11-v1', exposeToApp: true },
    {
      key: 'map.tileProvider',
      type: 'json',
      default: { id: 'osm-dev', urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors', maxZoom: 19, subdomains: [] },
      description: 'ADR-014 swappable tile provider; public OSM tiles are for development only',
      exposeToApp: true,
    },
    // Background location plugin choice (decision 2026-11-15: free now, paid switchable later from admin settings).
    // The paid plugin's licence key is bound to the app id and ships in the app build, never in this DB.
    { key: 'location.trackingProvider', type: 'enum', enum: ['free', 'paid'], default: 'free', exposeToApp: true, description: 'Which background-location plugin the staff app uses' },
    { key: 'location.providerConfig', type: 'json', default: {}, exposeToApp: true, description: 'Non-secret provider tuning (distanceFilterM, intervalSec, …) passed to the app' },
    { key: 'attendance.defaultShift', type: 'json', default: { start: '09:00', end: '21:00', weeklyOff: [5], lateGraceMin: 15, maxBreakMin: 60, breakWindows: [] }, schema: defaultShiftSchema, branchOverridable: true, exposeToApp: true, description: 'FR-SET-003 duty hours of everyone without a named shift, org-wide or per branch: start, end, weekly off days (may be empty), late grace, break limit and weekly break windows (FR-ATT-010)' },
    { key: 'locale.default', type: 'enum', enum: ['bn', 'en'], default: 'bn', exposeToApp: true },
  ],
  migrations: [
    indexMigration('20261115-0001-settings-indexes', [
      { collection: 'settings', key: { key: 1, scope: 1, branchId: 1 }, options: { unique: true } },
      { collection: 'holidays', key: { date: 1 } },
    ]),
  ],
};
