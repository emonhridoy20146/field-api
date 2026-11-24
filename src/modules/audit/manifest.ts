import type { ModuleManifest } from '../../core/module/types.js';
import { indexMigration } from '../../core/db/migrations.js';
import { auditRoutes } from './routes.js';

export const manifest: ModuleManifest = {
  name: 'audit',
  version: '1.0.0',
  core: true,
  description: 'Append-only, hash-chained audit log (FR-AUD-*)',
  dependsOn: [],
  permissions: [
    { key: 'audit.view', description: { en: 'View audit log in scope', bn: 'অডিট লগ দেখা' }, defaults: { super_admin: true, area_manager: true, viewer: true } },
  ],
  routes: auditRoutes,
  migrations: [
    indexMigration('20261115-0001-audit-indexes', [
      { collection: 'audit_logs', key: { seq: 1 }, options: { unique: true } },
      { collection: 'audit_logs', key: { at: -1 } },
      { collection: 'audit_logs', key: { entity: 1, entityId: 1, at: -1 } },
      { collection: 'audit_logs', key: { actorId: 1, at: -1 } },
      { collection: 'audit_logs', key: { branchId: 1, action: 1, at: -1 } },
    ]),
  ],
};
