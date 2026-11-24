import type { ModuleManifest } from '../../core/module/types.js';
import { ctx } from '../../core/context/index.js';
import { indexMigration } from '../../core/db/migrations.js';
import type { ErpBranch } from '../erp-gateway/index.js';
import { branchRoutes } from './routes.js';
import { upsertFromErp } from './service.js';

export const manifest: ModuleManifest = {
  name: 'branches',
  version: '1.0.0',
  core: true,
  description: 'Branch mirror from Laravel plus FOS-only extras (FR-BR-001)',
  dependsOn: ['erp-gateway', 'audit'],
  permissions: [
    {
      key: 'branch.view',
      description: { en: 'View branches', bn: 'শাখা দেখা' },
      defaults: { super_admin: true, area_manager: true, branch_manager: true, field_staff: true, viewer: true },
    },
  ],
  routes: branchRoutes,
  events: { emits: ['branch.synced'], consumes: ['erp.branches.synced'] },
  migrations: [
    indexMigration('20261115-0001-branches-indexes', [
      { collection: 'branches', key: { erpBranchId: 1 }, options: { unique: true } },
      { collection: 'branches', key: { code: 1 }, options: { unique: true } },
    ]),
  ],
  init() {
    ctx().bus.on('erp.branches.synced', async (p) => upsertFromErp(p.branches as ErpBranch[]));
  },
};
