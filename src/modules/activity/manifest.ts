import type { ModuleManifest } from '../../core/module/types.js';
import { indexMigration } from '../../core/db/migrations.js';
import { CONSUMED_EVENTS, RETENTION_DAYS } from './domain/feed.js';
import { activityRoutes } from './routes.js';
import { subscribe } from './service.js';

export const manifest: ModuleManifest = {
  name: 'activity',
  version: '1.0.0',
  description: 'Staff activity feed for admins: collections, visits, promises and pins as they happen, with a count of what is new (FR-ACT-001)',
  // New modules start OFF (CLAUDE.md §5).
  featureFlag: { key: 'module.activity', default: false, description: 'Staff activity feed', owner: 'field-api' },
  dependsOn: ['users', 'customers'],
  permissions: [{ key: 'activity.view', description: { en: 'See the staff activity feed in scope', bn: 'কর্মীদের কাজের ফিড দেখা' }, defaults: { super_admin: true, area_manager: true, branch_manager: true, viewer: true } }],
  routes: activityRoutes,
  events: { emits: [], consumes: CONSUMED_EVENTS },
  migrations: [
    indexMigration('20261121-0001-activity-indexes', [
      { collection: 'activity_items', key: { key: 1 }, options: { unique: true } },
      { collection: 'activity_items', key: { branchId: 1, _id: -1 } },
      { collection: 'activity_items', key: { at: 1 }, options: { expireAfterSeconds: RETENTION_DAYS * 86_400 } },
      { collection: 'activity_seen', key: { userId: 1 }, options: { unique: true } },
    ]),
  ],
  init() {
    subscribe();
  },
};
