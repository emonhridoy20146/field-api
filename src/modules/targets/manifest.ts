import type { ModuleManifest } from '../../core/module/types.js';
import { indexMigration } from '../../core/db/migrations.js';
import { targetRoutes } from './routes.js';

export const manifest: ModuleManifest = {
  name: 'targets',
  version: '1.0.0',
  description: 'Daily amount and visit targets per staff with branch defaults, dated so history never changes (FR-COL-015)',
  // New modules start OFF (CLAUDE.md §5).
  featureFlag: { key: 'module.targets', default: false, description: 'Daily targets', owner: 'field-api' },
  dependsOn: ['audit', 'users', 'branches', 'attendance'],
  permissions: [
    { key: 'target.view', description: { en: 'View daily targets in scope', bn: 'দৈনিক টার্গেট দেখা' }, defaults: { super_admin: true, area_manager: true, branch_manager: true, viewer: true } },
    { key: 'target.manage', description: { en: 'Set daily targets for staff and branch defaults', bn: 'দৈনিক টার্গেট নির্ধারণ' }, defaults: { super_admin: true, area_manager: true, branch_manager: true } },
  ],
  routes: targetRoutes,
  events: { emits: [], consumes: [] },
  migrations: [
    indexMigration('20261117-0001-targets-indexes', [
      { collection: 'staff_targets', key: { userId: 1, effectiveFrom: 1 } },
      { collection: 'staff_targets', key: { branchId: 1, userId: 1, effectiveFrom: 1 } },
    ]),
  ],
};
