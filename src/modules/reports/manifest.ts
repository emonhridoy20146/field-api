import type { ModuleManifest } from '../../core/module/types.js';
import { reportRoutes } from './routes.js';

export const manifest: ModuleManifest = {
  name: 'reports',
  version: '1.0.0',
  description: 'Overview dashboard (FR-DSH-001); phase-3 reports and exports will live here',
  featureFlag: { key: 'module.reports', default: false, description: 'Dashboard and reports', owner: 'field-api' },
  dependsOn: ['flags', 'erp-gateway', 'customers', 'collections', 'visits', 'promises', 'attendance', 'cash', 'inbox'],
  permissions: [
    { key: 'report.view', description: { en: 'Reports and dashboards in scope', bn: 'রিপোর্ট ও ড্যাশবোর্ড দেখা' }, defaults: { super_admin: true, branch_manager: true, viewer: true } },
    { key: 'report.export', description: { en: 'Export reports (CSV/XLSX/PDF)', bn: 'রিপোর্ট এক্সপোর্ট' }, defaults: { super_admin: true, branch_manager: true } },
  ],
  routes: reportRoutes,
};
