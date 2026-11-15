import type { ModuleManifest } from '../../core/module/types.js';
import { ctx } from '../../core/context/index.js';
import { indexMigration } from '../../core/db/migrations.js';
import type { ErpCustomer } from '../erp-gateway/index.js';
import { customerRoutes } from './routes.js';
import { markMissing, recomputeAllDerived, syncLoad, syncSnapshot, upsertFromErp } from './service.js';

export const manifest: ModuleManifest = {
  name: 'customers',
  version: '1.0.0',
  description: 'Customer read model from Laravel plus FOS overlay; status, bad suggestion, map, pin corrections (FR-CUS-*)',
  featureFlag: { key: 'module.customers', default: false, description: 'Customer list, detail, map', owner: 'field-api' },
  dependsOn: ['audit', 'branches', 'users', 'erp-gateway'],
  permissions: [
    { key: 'customer.view', description: { en: 'View customers in scope', bn: 'গ্রাহক দেখা' }, defaults: { super_admin: true, branch_manager: true, field_staff: true, viewer: true } },
    { key: 'customer.export', description: { en: 'Export customer lists', bn: 'গ্রাহক তালিকা এক্সপোর্ট' }, defaults: { super_admin: true, branch_manager: true } },
    { key: 'customer.location.propose', description: { en: 'Propose a corrected pin', bn: 'সঠিক পিন প্রস্তাব' }, defaults: { super_admin: true, branch_manager: true, field_staff: true } },
    { key: 'customer.location.approve', description: { en: 'Approve/reject pin corrections', bn: 'পিন সংশোধন অনুমোদন' }, defaults: { super_admin: true, branch_manager: true } },
  ],
  routes: customerRoutes,
  events: {
    emits: ['customer.balance_cleared', 'customer.placed', 'customer.payments_synced', 'customer.location.proposed', 'customer.location.approved', 'customer.location.decided'],
    consumes: ['erp.customer.synced', 'erp.reconcile.completed'],
  },
  jobs: [{ name: 'customers.recompute-derived', schedule: '5 0 * * *', handler: async () => void (await recomputeAllDerived()) }],
  syncEntities: [{ entity: 'customer', load: syncLoad, snapshot: syncSnapshot }],
  migrations: [
    indexMigration('20261115-0001-customers-indexes', [
      { collection: 'erp_customers', key: { erpCustomerId: 1 }, options: { unique: true } },
      { collection: 'erp_customers', key: { branchId: 1, 'derived.overdue': 1, 'derived.daysOverdue': -1 } },
      { collection: 'erp_customers', key: { branchId: 1, 'derived.dueToday': 1 } },
      { collection: 'erp_customers', key: { branchId: 1, 'derived.badSuggested': 1 } },
      { collection: 'erp_customers', key: { 'fos.assigneeId': 1, 'derived.daysOverdue': -1 } },
      { collection: 'erp_customers', key: { erpBranchId: 1, erpStatus: 1 } },
      { collection: 'erp_customers', key: { location: '2dsphere' } },
      { collection: 'erp_customers', key: { phones: 1 } },
      { collection: 'location_proposals', key: { clientId: 1 }, options: { unique: true } },
      { collection: 'location_proposals', key: { branchId: 1, status: 1, createdAt: -1 } },
      { collection: 'location_proposals', key: { customerId: 1, decidedAt: -1 } },
    ]),
  ],
  init() {
    const bus = ctx().bus;
    bus.on('erp.customer.synced', async (p) => void (await upsertFromErp(p.customer as ErpCustomer, p.fetchedAt as Date)));
    bus.on('erp.reconcile.completed', async (p) => void (await markMissing(p.erpBranchId as string, p.seenErpCustomerIds as string[])));
  },
};
