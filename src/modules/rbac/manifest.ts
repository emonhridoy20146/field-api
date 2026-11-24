import type { ModuleManifest } from '../../core/module/types.js';
import { ctx } from '../../core/context/index.js';
import { indexMigration } from '../../core/db/migrations.js';
import { rbacRoutes } from './routes.js';
import { effectivePermissions, invalidate } from './service.js';

export const manifest: ModuleManifest = {
  name: 'rbac',
  version: '1.0.0',
  core: true,
  description: 'Permission catalog, overrides and evaluation (FR-RBAC-*)',
  dependsOn: ['audit', 'users'],
  permissions: [
    { key: 'rbac.view', description: { en: 'View roles, overrides, effective permissions', bn: 'অনুমতি দেখা' }, defaults: { super_admin: true, area_manager: true, branch_manager: true } },
    { key: 'rbac.manage', description: { en: 'Change branch/user permission overrides', bn: 'অনুমতি পরিবর্তন' }, defaults: { super_admin: true }, neverFor: ['area_manager'] },
  ],
  routes: rbacRoutes,
  events: { emits: ['rbac.changed'], consumes: ['user.updated'] },
  migrations: [
    indexMigration('20261115-0001-rbac-indexes', [
      { collection: 'permission_overrides', key: { level: 1, userId: 1, key: 1 }, options: { unique: true, partialFilterExpression: { level: 'user' } } },
      { collection: 'permission_overrides', key: { level: 1, branchId: 1, role: 1, key: 1 }, options: { unique: true, partialFilterExpression: { level: 'branch' } } },
    ]),
  ],
  init() {
    ctx().ports.permissions = effectivePermissions;
    ctx().bus.on('user.updated', (p) => invalidate(p.userId as string));
  },
};
