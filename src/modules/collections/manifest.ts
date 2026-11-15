import type { ModuleManifest } from '../../core/module/types.js';
import { syncMutations } from './sync.js';
import { ctx } from '../../core/context/index.js';
import { indexMigration } from '../../core/db/migrations.js';
import type { AuthUser } from '../../core/security/types.js';
import { registerDetailContributor, registerListEnricher, registerTimelineSource } from '../customers/index.js';
import { registerSummaryContributor } from '../handovers/index.js';
import { collectionRoutes } from './routes.js';
import * as s from './service.js';

export const manifest: ModuleManifest = {
  name: 'collections',
  version: '1.0.0',
  description: 'Field collections: idempotent record, ERP posting via outbox, conflicts, void, resolve (FR-COL-*)',
  featureFlag: { key: 'module.collections', default: false, description: 'Field collections', owner: 'field-api' },
  dependsOn: ['audit', 'settings', 'branches', 'users', 'customers', 'erp-gateway', 'handovers'],
  permissions: [
    { key: 'collection.record', description: { en: 'Record a field collection', bn: 'মাঠে টাকা আদায় রেকর্ড' }, defaults: { super_admin: true, branch_manager: true, field_staff: true } },
    { key: 'collection.view', description: { en: 'View collections in scope (own only for FS)', bn: 'আদায় দেখা' }, defaults: { super_admin: true, branch_manager: true, field_staff: true, viewer: true } },
    { key: 'collection.void', description: { en: 'Void a collection not yet posted to ERP', bn: 'পোস্টের আগে আদায় বাতিল' }, defaults: { super_admin: true, branch_manager: true } },
    { key: 'collection.resolve', description: { en: 'Resolve collection conflicts', bn: 'আদায়ের সমস্যা সমাধান' }, defaults: { super_admin: true, branch_manager: true } },
  ],
  routes: collectionRoutes,
  events: {
    emits: ['collection.received', 'collection.posted', 'collection.conflict', 'collection.posting_failed', 'collection.voided', 'collection.resolved', 'collection.reversed', 'collection.posted_after_close'],
    consumes: ['erp.payment.posting', 'erp.payment.posted', 'erp.payment.rejected', 'erp.payment.retrying', 'erp.payment.failed', 'erp.payment.deferred', 'customer.payments_synced'],
  },
  settings: [
    { key: 'collections.geofenceM', type: 'int', default: 300, branchOverridable: true, exposeToApp: true, description: 'FR-COL-013 far_from_pin radius' },
    { key: 'collections.txnRefPatterns', type: 'json', default: {}, exposeToApp: true, description: 'Overrides of per-method transaction id regex' },
    { key: 'collections.photoRequiredAbovePoisha', type: 'int', default: 0, branchOverridable: true, exposeToApp: true, description: 'App requires a photo above this amount (0 = off); server never rejects for it' },
  ],
  jobs: [{ name: 'collections.requeue-stuck', schedule: '*/10 * * * *', handler: async () => void (await s.requeueStuck()) }],
  inboxTypes: [
    { type: 'collection.conflict', severity: 'high' },
    { type: 'collection.posting_failed', severity: 'critical' },
    { type: 'collection.flagged', severity: 'medium' },
  ],
  notificationTypes: [{ type: 'collection.conflict' }, { type: 'collection.resolved' }],
  syncEntities: [
    {
      entity: 'collection',
      load: async (ids: string[], user: AuthUser) => {
        const out = new Map<string, Record<string, unknown>>();
        for (const id of ids) {
          try {
            out.set(id, await s.get(user, id));
          } catch {
            /* out of scope → tombstone */
          }
        }
        return out;
      },
    },
  ],
  syncMutations,
  migrations: [
    indexMigration('20261115-0001-collections-indexes', [
      { collection: 'collections', key: { idempotencyKey: 1 }, options: { unique: true } },
      { collection: 'collections', key: { receiptNo: 1 }, options: { unique: true } },
      { collection: 'collections', key: { collectorId: 1, businessDate: -1 } },
      { collection: 'collections', key: { branchId: 1, businessDate: -1, status: 1 } },
      { collection: 'collections', key: { customerId: 1, recordedAt: -1 } },
      { collection: 'collections', key: { status: 1, 'erp.attempts': 1 } },
      { collection: 'collections', key: { method: 1, transactionRef: 1 }, options: { sparse: true } },
      { collection: 'collections', key: { 'erp.paymentId': 1 }, options: { sparse: true } },
      { collection: 'receipt_blocks', key: { userId: 1, businessDate: -1 } },
    ]),
  ],
  init() {
    const bus = ctx().bus;
    bus.on('erp.payment.posting', async (p) => s.onPosting(p as never));
    bus.on('erp.payment.posted', async (p) => s.onPosted(p as never));
    bus.on('erp.payment.rejected', async (p) => s.onRejected(p as never));
    bus.on('erp.payment.retrying', async (p) => s.onRetrying(p as never));
    bus.on('erp.payment.failed', async (p) => s.onFailed(p as never));
    bus.on('erp.payment.deferred', async (p) => s.onDeferred(p as never));
    bus.on('customer.payments_synced', async (p) => s.onPaymentsSynced(p as never));
    registerListEnricher(async (ids) => new Map([...(await s.pendingByCustomer(ids))].map(([k, v]) => [k, { pendingFieldPoisha: v }])));
    registerDetailContributor(async (c) => ({ pendingCollections: await s.pendingForDetail(c.id) }));
    registerTimelineSource(async (customerId, _u, before, limit) => s.timelineItems(customerId, before, limit));
    registerSummaryContributor(async (p) => ({ openConflicts: await s.openConflictsFor(p.customerIds) }));
  },
};
