import type { ModuleManifest } from '../../core/module/types.js';
import { syncMutations } from './sync.js';
import { ctx } from '../../core/context/index.js';
import { indexMigration } from '../../core/db/migrations.js';
import type { AuthUser } from '../../core/security/types.js';
import { registerListEnricher, registerTimelineSource } from '../customers/index.js';
import { registerSummaryContributor } from '../handovers/index.js';
import { promiseRoutes } from './routes.js';
import * as s from './service.js';

export const manifest: ModuleManifest = {
  name: 'promises',
  version: '1.0.0',
  description: 'Promise-to-pay with supersede, reminders and nightly evaluation (FR-PRM-001..003)',
  featureFlag: { key: 'module.promises', default: false, description: 'Promises to pay', owner: 'field-api' },
  dependsOn: ['settings', 'users', 'customers', 'handovers'],
  permissions: [
    { key: 'promise.create', description: { en: 'Record/update promise-to-pay', bn: 'প্রতিশ্রুতি রেকর্ড' }, defaults: { super_admin: true, branch_manager: true, field_staff: true } },
    { key: 'promise.view', description: { en: 'View promises in scope', bn: 'প্রতিশ্রুতি দেখা' }, defaults: { super_admin: true, branch_manager: true, field_staff: true, viewer: true } },
  ],
  routes: promiseRoutes,
  events: { emits: ['promise.created', 'promise.kept', 'promise.broken', 'promise.due'], consumes: ['customer.payments_synced', 'handover.accepted'] },
  settings: [{ key: 'promises.graceDays', type: 'int', default: 1, branchOverridable: true, exposeToApp: true, description: 'FR-PRM-003 grace days after the promised date' }],
  jobs: [
    { name: 'promises.evaluate', schedule: '30 0 * * *', handler: async () => void (await s.evaluateDue()) },
    { name: 'promises.remind', schedule: '0 9 * * *', handler: async () => void (await s.remindToday()) },
  ],
  notificationTypes: [{ type: 'promise.due' }, { type: 'promise.broken' }],
  inboxTypes: [{ type: 'promise.broken', severity: 'medium' }],
  syncEntities: [
    {
      entity: 'promise',
      load: async (ids: string[], user: AuthUser) => {
        const out = new Map<string, Record<string, unknown>>();
        for (const id of ids) await s.get(user, id).then((v) => out.set(id, v), () => undefined);
        return out;
      },
      snapshot: s.syncSnapshot,
    },
  ],
  syncMutations,
  migrations: [
    indexMigration('20261115-0001-promises-indexes', [
      { collection: 'promises', key: { clientId: 1 }, options: { unique: true } },
      { collection: 'promises', key: { customerId: 1, status: 1 } },
      { collection: 'promises', key: { ownerId: 1, status: 1, promisedDate: 1 } },
      { collection: 'promises', key: { branchId: 1, promisedDate: 1, status: 1 } },
      { collection: 'promises', key: { status: 1, promisedDate: 1 } },
    ]),
  ],
  init() {
    const bus = ctx().bus;
    bus.on('customer.payments_synced', async (p) => s.onPaymentsSynced(p.customerId as string));
    bus.on('handover.accepted', async (p) => s.onHandoverAccepted(p as never));
    registerListEnricher(async (ids) => new Map([...(await s.openByCustomer(ids))].map(([k, v]) => [k, { openPromise: v }])));
    registerTimelineSource(async (customerId, _u, before, limit) => s.timelineItems(customerId, before, limit));
    registerSummaryContributor(async (p) => ({ openPromises: await s.openCount(p.customerIds) }));
  },
};
