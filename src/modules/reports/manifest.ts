import type { ModuleManifest } from '../../core/module/types.js';
import { indexMigration } from '../../core/db/migrations.js';
import { reportRoutes } from './routes.js';
import { snapshotOverdue } from './trends.js';
import { processExports } from './exports.js';

export const manifest: ModuleManifest = {
  name: 'reports',
  version: '1.0.0',
  description: 'Overview dashboard (FR-DSH-001), staff performance, branch trends, reconciliation, exports (FR-REP-001..004, FR-COL-014)',
  featureFlag: { key: 'module.reports', default: false, description: 'Dashboard and reports', owner: 'field-api' },
  dependsOn: ['flags', 'audit', 'rbac', 'users', 'branches', 'erp-gateway', 'customers', 'collections', 'visits', 'promises', 'attendance', 'cash', 'inbox', 'location'],
  permissions: [
    { key: 'report.view', description: { en: 'Reports and dashboards in scope', bn: 'রিপোর্ট ও ড্যাশবোর্ড দেখা' }, defaults: { super_admin: true, branch_manager: true, viewer: true } },
    { key: 'report.export', description: { en: 'Export reports (CSV/XLSX/PDF)', bn: 'রিপোর্ট এক্সপোর্ট' }, defaults: { super_admin: true, branch_manager: true } },
  ],
  routes: reportRoutes,
  jobs: [
    // 23:50 Dhaka: the day's closing overdue picture, before the ERP reconcile changes tomorrow's.
    { name: 'reports.overdue-snapshot', schedule: '50 23 * * *', handler: async () => void (await snapshotOverdue()) },
    { name: 'reports.exports', schedule: '* * * * *', handler: async () => void (await processExports()) },
  ],
  migrations: [
    indexMigration('20261116-0001-reports-indexes', [
      { collection: 'overdue_snapshots', key: { businessDate: 1, branchId: 1 }, options: { unique: true } },
      { collection: 'exports', key: { status: 1, createdAt: 1 } },
      { collection: 'exports', key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
    ]),
  ],
};
