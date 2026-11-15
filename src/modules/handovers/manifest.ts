import type { ModuleManifest } from '../../core/module/types.js';
import { ctx } from '../../core/context/index.js';
import { indexMigration } from '../../core/db/migrations.js';
import { handoverRoutes } from './routes.js';
import { onUserDeactivated, tick } from './service.js';

export const manifest: ModuleManifest = {
  name: 'handovers',
  version: '1.0.0',
  description: 'Staff-to-staff handover with receiver acceptance, 72 h expiry and temporary cover (FR-HO-*)',
  featureFlag: { key: 'module.handovers', default: false, description: 'Handovers', owner: 'field-api' },
  dependsOn: ['audit', 'rbac', 'users', 'customers', 'assignments'],
  permissions: [
    { key: 'handover.create', description: { en: 'Create a handover between staff', bn: 'হস্তান্তর তৈরি' }, defaults: { super_admin: true, branch_manager: true } },
    { key: 'handover.request', description: { en: 'Request handover of own customers (FR-HO-007, P4)', bn: 'নিজের গ্রাহক হস্তান্তরের অনুরোধ' }, defaults: { super_admin: true, branch_manager: true } },
  ],
  routes: handoverRoutes,
  events: {
    emits: ['handover.created', 'handover.accepted', 'handover.rejected', 'handover.cancelled', 'handover.expired', 'handover.unaccepted', 'handover.reverted'],
    consumes: ['user.deactivated'],
  },
  jobs: [{ name: 'handovers.tick', schedule: '*/15 * * * *', handler: async () => void (await tick()) }],
  inboxTypes: [{ type: 'handover.unaccepted', severity: 'medium' }],
  notificationTypes: [{ type: 'handover.created' }, { type: 'handover.decided' }],
  migrations: [
    indexMigration('20261115-0001-handovers-indexes', [
      { collection: 'handovers', key: { toUserId: 1, status: 1 } },
      { collection: 'handovers', key: { fromUserId: 1, createdAt: -1 } },
      { collection: 'handovers', key: { branchId: 1, status: 1, createdAt: -1 } },
      { collection: 'handovers', key: { status: 1, expiresAt: 1 } },
    ]),
  ],
  init() {
    ctx().bus.on('user.deactivated', async (p) => onUserDeactivated(p.userId as string));
  },
};
