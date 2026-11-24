import type { ModuleManifest } from '../../core/module/types.js';
import { ctx } from '../../core/context/index.js';
import { indexMigration } from '../../core/db/migrations.js';
import { assignmentRoutes } from './routes.js';
import { registerListEnricher, registerTimelineSource } from '../customers/index.js';
import { areaNamesFor, customerTimeline, recomputeBranch } from './service.js';

export const manifest: ModuleManifest = {
  name: 'assignments',
  version: '1.0.0',
  description: 'Areas and staff assignments; computes each customer’s primary assignee (FR-ASG-*)',
  featureFlag: { key: 'module.assignments', default: false, description: 'Areas and assignments', owner: 'field-api' },
  dependsOn: ['audit', 'users', 'customers'],
  permissions: [
    { key: 'assignment.view', description: { en: 'View assignments and areas', bn: 'এলাকা ও দায়িত্ব দেখা' }, defaults: { super_admin: true, area_manager: true, branch_manager: true, field_staff: true, viewer: true } },
    { key: 'assignment.manage', description: { en: 'Assign customers/areas, edit areas', bn: 'গ্রাহক/এলাকা দায়িত্ব দেওয়া' }, defaults: { super_admin: true, area_manager: true, branch_manager: true } },
  ],
  routes: assignmentRoutes,
  events: { emits: ['assignment.changed'], consumes: ['customer.placed'] },
  migrations: [
    indexMigration('20261115-0001-assignments-indexes', [
      { collection: 'areas', key: { branchId: 1, code: 1 }, options: { unique: true } },
      { collection: 'areas', key: { polygon: '2dsphere' }, options: { sparse: true } },
      { collection: 'assignments', key: { userId: 1, effectiveTo: 1 } },
      { collection: 'assignments', key: { customerId: 1, effectiveTo: 1 } },
      { collection: 'assignments', key: { areaId: 1, effectiveTo: 1 } },
      { collection: 'assignments', key: { branchId: 1, effectiveTo: 1 } },
      { collection: 'assignments', key: { source: 1 } },
    ]),
  ],
  init() {
    registerTimelineSource(customerTimeline);
    registerListEnricher(async (ids) => new Map([...(await areaNamesFor(ids))].map(([k, v]) => [k, { areaName: v }])));
    // A new or moved customer may fall into (or out of) an area: recompute just that customer.
    ctx().bus.on('customer.placed', async (p) => void (p.branchId ? await recomputeBranch(p.branchId as string, [p.customerId as string]) : 0));
  },
};
