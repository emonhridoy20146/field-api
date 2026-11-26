import type { ModuleManifest } from '../../core/module/types.js';
import { syncMutations } from './sync.js';
import { ctx } from '../../core/context/index.js';
import { indexMigration } from '../../core/db/migrations.js';
import { raiseResyncFloor } from '../../core/changefeed/index.js';
import type { ErpCustomer } from '../erp-gateway/index.js';
import { customerRoutes } from './routes.js';
import { branchProposalsSnapshot, markMissing, recomputeAllDerived, proposalSyncLoad, refeedBranches, setAsideReturnedPlans, syncLoad, syncSnapshot, upsertFromErp } from './service.js';
import { listBranches } from '../branches/index.js';

export const manifest: ModuleManifest = {
  name: 'customers',
  version: '1.0.0',
  description: 'Customer read model from Laravel plus FOS overlay; status, bad suggestion, map, pin corrections and map pins (FR-CUS-*)',
  featureFlag: { key: 'module.customers', default: false, description: 'Customer list, detail, map', owner: 'field-api' },
  dependsOn: ['audit', 'settings', 'branches', 'users', 'erp-gateway'],
  permissions: [
    { key: 'customer.view', description: { en: 'View customers in scope', bn: 'গ্রাহক দেখা' }, defaults: { super_admin: true, area_manager: true, branch_manager: true, field_staff: true, viewer: true } },
    { key: 'customer.export', description: { en: 'Export customer lists', bn: 'গ্রাহক তালিকা এক্সপোর্ট' }, defaults: { super_admin: true, area_manager: true, branch_manager: true } },
    { key: 'customer.phone.manage', description: { en: 'Add or remove extra phone numbers of a customer', bn: 'গ্রাহকের বাড়তি ফোন নম্বর যোগ বা বাদ দেওয়া' }, defaults: { super_admin: true, area_manager: true, branch_manager: true, field_staff: true } },
    { key: 'customer.location.propose', description: { en: 'Propose a corrected pin', bn: 'সঠিক পিন প্রস্তাব' }, defaults: { super_admin: true, area_manager: true, branch_manager: true, field_staff: true } },
    { key: 'customer.location.approve', description: { en: 'Approve/reject pin corrections; set or delete a pin on the map', bn: 'পিন সংশোধন অনুমোদন; ম্যাপে পিন বসানো বা মুছে ফেলা' }, defaults: { super_admin: true, area_manager: true, branch_manager: true } },
  ],
  routes: customerRoutes,
  settings: [
    {
      key: 'customers.staffPinApproval',
      type: 'enum',
      enum: ['when_missing', 'always'],
      default: 'when_missing',
      branchOverridable: true,
      exposeToApp: true,
      description: 'FR-CUS-011 / ADR-031: when_missing = a staff pin for a customer without a usable pin applies at once (moving a pin still needs approval); always = every staff pin waits for a manager',
    },
    {
      key: 'customers.staffVisibility',
      type: 'enum',
      enum: ['branch', 'assigned'],
      default: 'branch',
      branchOverridable: true,
      exposeToApp: true,
      description: 'FR-CUS-015 / ADR-038: branch = field staff see every customer of their branches (owner request 2026-11-18); assigned = only customers assigned to them (the rule before 1.19.0)',
    },
  ],
  events: {
    emits: ['customer.balance_cleared', 'customer.placed', 'customer.payments_synced', 'customer.location.proposed', 'customer.location.approved', 'customer.location.cleared', 'customer.location.decided'],
    consumes: ['erp.customer.synced', 'erp.reconcile.completed', 'user.updated', 'settings.changed'],
  },
  jobs: [{ name: 'customers.recompute-derived', schedule: '5 0 * * *', handler: async () => void (await recomputeAllDerived()) }],
  syncEntities: [
    { entity: 'customer', load: syncLoad, snapshot: syncSnapshot },
    { entity: 'location_proposal', load: proposalSyncLoad, snapshot: async (user) => branchProposalsSnapshot(user) },
  ],
  syncMutations,
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
    // 1.46.0 (ADR-062): each list sort (all end with _id) served from an index, so 1000-row pages and deep offsets
    // never sort in memory: branch first for scoped users and `branchId=`, sort-only for the super admin (no branch).
    indexMigration('20261123-0001-customers-list-sort-indexes', [
      { collection: 'erp_customers', key: { branchId: 1, 'derived.daysOverdue': -1, _id: 1 } },
      { collection: 'erp_customers', key: { branchId: 1, 'name.en': 1, _id: 1 } },
      { collection: 'erp_customers', key: { branchId: 1, 'derived.totalOutstandingPoisha': -1, _id: 1 } },
      { collection: 'erp_customers', key: { branchId: 1, 'derived.nextDueDate': 1, _id: 1 } },
      { collection: 'erp_customers', key: { 'derived.daysOverdue': -1, _id: 1 } },
      { collection: 'erp_customers', key: { 'name.en': 1, _id: 1 } },
      { collection: 'erp_customers', key: { 'derived.totalOutstandingPoisha': -1, _id: 1 } },
      { collection: 'erp_customers', key: { 'derived.nextDueDate': 1, _id: 1 } },
    ]),
    // 1.14.0 (ADR-035): fill derived.missedCount (pin colours) for customers cached before it existed.
    { id: '20261118-0001-derive-missed-installments', up: async () => void (await recomputeAllDerived()) },
    // 1.50.0 (FR-CUS-023, ADR-068): returned invoices cached in `plans` move to `returnedPlans`; phones get the update.
    { id: '20261126-0001-set-aside-returned-plans', up: async () => void (await setAsideReturnedPlans()) },
  ],
  async init() {
    // ADR-038: phones that took their snapshot when staff saw only assigned customers reload once.
    await raiseResyncFloor('customers-branch-wide');
    const bus = ctx().bus;
    bus.on('erp.customer.synced', async (p) => void (await upsertFromErp(p.customer as ErpCustomer, p.fetchedAt as Date)));
    bus.on('erp.reconcile.completed', async (p) => void (await markMissing(p.erpBranchId as string, p.seenErpCustomerIds as string[])));
    // ADR-038: a staff member's devices get the customers of a branch they joined and drop those of one they left.
    bus.on('user.updated', async (p) => {
      if (!p.branchesChanged) return;
      const before = (p.previousBranchIds as string[] | undefined) ?? [];
      const after = (p.branchIds as string[] | undefined) ?? [];
      const changed = [...before.filter((b) => !after.includes(b)), ...after.filter((b) => !before.includes(b))];
      if (changed.length) await refeedBranches(changed, p.userId as string);
    });
    // Visibility switched (branch ↔ assigned): every device of the branch reloads or drops its customers.
    bus.on('settings.changed', async (p) => {
      if (!(p.keys as string[]).includes('customers.staffVisibility')) return;
      const branchIds = p.branchId ? [p.branchId as string] : (await listBranches()).map((b) => b.id);
      await refeedBranches(branchIds);
    });
  },
};
