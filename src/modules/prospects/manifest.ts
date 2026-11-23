import type { ModuleManifest } from '../../core/module/types.js';
import { indexMigration } from '../../core/db/migrations.js';
import { prospectRoutes } from './routes.js';
import { syncMutations } from './sync.js';
import * as s from './service.js';

export const manifest: ModuleManifest = {
  name: 'prospects',
  version: '1.0.0',
  description: 'Possible customers recorded by staff and the office; converted to a customer or dropped, re-opened when they return (FR-PRO-001)',
  // New modules start OFF (CLAUDE.md §5); the owner turns `module.prospects` on in admin → flags.
  featureFlag: { key: 'module.prospects', default: false, description: 'Possible customers (prospects)', owner: 'field-api' },
  dependsOn: ['audit', 'rbac', 'branches', 'customers'],
  permissions: [
    {
      key: 'prospect.create',
      description: { en: 'Record a possible customer; see the ones you recorded', bn: 'সম্ভাব্য গ্রাহক যোগ করা; নিজের যোগ করা গুলো দেখা' },
      defaults: { super_admin: true, branch_manager: true, field_staff: true },
    },
    { key: 'prospect.view', description: { en: 'See possible customers in scope', bn: 'আওতাধীন সম্ভাব্য গ্রাহক দেখা' }, defaults: { super_admin: true, branch_manager: true, viewer: true } },
    {
      key: 'prospect.manage',
      description: { en: 'Edit, convert, drop and re-open possible customers', bn: 'সম্ভাব্য গ্রাহক সম্পাদনা, রূপান্তর, বাদ ও পুনরায় খোলা' },
      defaults: { super_admin: true, branch_manager: true },
    },
  ],
  routes: prospectRoutes,
  events: { emits: ['prospect.created', 'prospect.updated', 'prospect.converted', 'prospect.reopened'], consumes: [] },
  syncEntities: [{ entity: 'prospect', load: s.syncLoad, snapshot: s.snapshot }],
  syncMutations,
  migrations: [
    indexMigration('20261123-0001-prospects-indexes', [
      { collection: 'prospects', key: { clientId: 1 }, options: { unique: true } },
      { collection: 'prospects', key: { branchId: 1, createdAt: -1 } },
      { collection: 'prospects', key: { 'createdBy.id': 1, createdAt: -1 } },
      { collection: 'prospects', key: { status: 1, branchId: 1 } },
    ]),
  ],
};
