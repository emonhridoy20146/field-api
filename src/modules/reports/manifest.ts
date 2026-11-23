import type { ModuleManifest } from '../../core/module/types.js';
import { indexMigration } from '../../core/db/migrations.js';
import { reportRoutes } from './routes.js';
import { snapshotOverdue } from './trends.js';
import { processExports } from './exports.js';

export const manifest: ModuleManifest = {
  name: 'reports',
  version: '1.0.0',
  description: 'Overview dashboard (FR-DSH-001), staff performance with targets, branch trends, reconciliation, leaderboard and own performance, data quality, exports incl. Bangla PDF (FR-REP-001..005, FR-COL-014/015, FR-CUS-009)',
  featureFlag: { key: 'module.reports', default: false, description: 'Dashboard and reports', owner: 'field-api' },
  dependsOn: ['flags', 'audit', 'rbac', 'users', 'branches', 'erp-gateway', 'customers', 'collections', 'visits', 'promises', 'attendance', 'cash', 'inbox', 'location', 'cowork', 'targets', 'settings'],
  permissions: [
    { key: 'report.view', description: { en: 'Reports and dashboards in scope', bn: 'রিপোর্ট ও ড্যাশবোর্ড দেখা' }, defaults: { super_admin: true, branch_manager: true, viewer: true } },
    { key: 'report.export', description: { en: 'Export reports (CSV/XLSX/PDF)', bn: 'রিপোর্ট এক্সপোর্ট' }, defaults: { super_admin: true, branch_manager: true } },
  ],
  routes: reportRoutes,
  settings: [
    { key: 'reports.leaderboardVisibleToStaff', type: 'bool', default: false, branchOverridable: true, exposeToApp: true, description: 'FR-REP-005 / OD-15: field staff may see the leaderboard of their branch and their own rank (managers always can)' },
    { key: 'reports.leaderboardScope', type: 'enum', enum: ['all', 'branch'], default: 'all', exposeToApp: true, description: 'FR-REP-007 the collection board covers every branch for everyone who may open it (all), or only the branches of the viewer (branch)' },
    { key: 'reports.leaderboardMinPresentDays', type: 'int', default: 1, branchOverridable: true, description: 'FR-REP-005 present days in the period needed to be ranked' },
    { key: 'reports.dataQualityMaxBranchKm', type: 'number', default: 30, branchOverridable: true, description: 'FR-CUS-009 a customer pin farther than this from the branch is reported as far_from_branch' },
  ],
  jobs: [
    // 23:50 Dhaka: the day's closing overdue picture, before the ERP reconcile changes tomorrow's.
    { name: 'reports.overdue-snapshot', schedule: '50 23 * * *', catchUpMin: 9, handler: async () => void (await snapshotOverdue()) },
    { name: 'reports.exports', schedule: '* * * * *', catchUpMin: 5, handler: async () => void (await processExports()) },
  ],
  migrations: [
    indexMigration('20261116-0001-reports-indexes', [
      { collection: 'overdue_snapshots', key: { businessDate: 1, branchId: 1 }, options: { unique: true } },
      { collection: 'exports', key: { status: 1, createdAt: 1 } },
      { collection: 'exports', key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
    ]),
  ],
};
