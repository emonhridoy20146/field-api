import type { ModuleManifest } from '../../core/module/types.js';
import { indexMigration } from '../../core/db/migrations.js';
import { syncRoutes } from './routes.js';

export const manifest: ModuleManifest = {
  name: 'sync',
  version: '1.0.0',
  description: 'Offline sync for the staff app: pull change feed, push mutation batch, bootstrap snapshot, device sync health (FR-SYNC-001..006)',
  featureFlag: { key: 'module.sync', default: false, description: 'Mobile offline sync', owner: 'field-api' },
  dependsOn: ['rbac', 'flags', 'settings', 'users', 'cash', 'targets'],
  permissions: [],
  routes: syncRoutes,
  migrations: [
    indexMigration('20261115-0001-sync-indexes', [
      { collection: 'sync_changes', key: { userIds: 1, seq: 1 } },
      // Devices away longer than this get 410 CURSOR_EXPIRED and bootstrap again.
      { collection: 'sync_changes', key: { at: 1 }, options: { expireAfterSeconds: 30 * 86_400 } },
      { collection: 'device_sync_state', key: { deviceId: 1, userId: 1 }, options: { unique: true } },
      { collection: 'device_sync_state', key: { branchId: 1, lastPullAt: -1 } },
    ]),
    // 1.15.0 (ADR-036): branch-wide customer changes reach every device of the branch.
    indexMigration('20261118-0001-sync-fanout-index', [{ collection: 'sync_changes', key: { fanoutBranchId: 1, seq: 1 } }]),
  ],
};
