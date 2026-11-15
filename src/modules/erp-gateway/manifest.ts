import type { ModuleManifest } from '../../core/module/types.js';
import { registerOutboxHandler } from '../../core/events/outbox.js';
import { erpRoutes } from './routes.js';
import { deltaSync, handlePostPayment, onPostPaymentGaveUp, reconcile } from './service.js';

export const manifest: ModuleManifest = {
  name: 'erp-gateway',
  version: '1.0.0',
  core: true,
  description: 'The only integration point with the Laravel ERP (ADR-005)',
  dependsOn: ['settings'],
  permissions: [],
  routes: erpRoutes,
  events: {
    emits: [
      'erp.branches.synced',
      'erp.customer.synced',
      'erp.reconcile.completed',
      'erp.payment.posting',
      'erp.payment.posted',
      'erp.payment.rejected',
      'erp.payment.retrying',
      'erp.payment.failed',
      'erp.payment.deferred',
      'erp.auth_failed',
    ],
    consumes: ['outbox:erp.post_payment'],
  },
  settings: [
    { key: 'erp.recordOnly', type: 'bool', default: false, description: 'FR-ERP-005 record-only fallback' },
    { key: 'erp.staleAfterMin', type: 'int', default: 15, description: 'FR-ERP-004 admin header warning' },
  ],
  jobs: [
    { name: 'erp.delta-sync', schedule: '*/5 * * * *', handler: async () => void (await deltaSync()) },
    { name: 'erp.nightly-reconcile', schedule: '0 2 * * *', handler: async () => void (await reconcile()) },
  ],
  init() {
    registerOutboxHandler('erp.post_payment', handlePostPayment, onPostPaymentGaveUp);
  },
};
