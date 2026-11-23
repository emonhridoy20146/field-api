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
  permissions: [
    { key: 'erp.sync', description: { en: 'Pull the latest customer data from the ERP now ("Sync from ERP")', bn: 'ERP থেকে এখনই সর্বশেষ গ্রাহক তথ্য আনা' }, defaults: { super_admin: true, branch_manager: true } },
  ],
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
    {
      key: 'erp.customerScope',
      type: 'enum',
      enum: ['receivables', 'all'],
      default: 'all',
      description:
        'FR-ERP-008 (1.44.0, owner decision 2026-11-23): which ERP customers and invoices are pulled. all (default) = every customer and every invoice, cash sales included (shown, never due); receivables = only customers with an installment or credit invoice (the pull before 1.44.0). A change makes the next pull start over for every branch',
    },
  ],
  jobs: [
    // 1.45.0 (owner request 2026-11-23): every 2 minutes, so the app is fresh without anyone pressing "Sync from ERP".
    // In a serverless cron call the run gets the call's time left (budgetMs) and resumes on the next call (1.17.0).
    { name: 'erp.delta-sync', schedule: '*/2 * * * *', catchUpMin: 10, handler: async (o) => void (await deltaSync(o?.budgetMs !== undefined ? { budgetMs: o.budgetMs } : {})) },
    { name: 'erp.nightly-reconcile', schedule: '0 2 * * *', heavy: true, handler: async () => void (await reconcile()) },
  ],
  init() {
    registerOutboxHandler('erp.post_payment', handlePostPayment, onPostPaymentGaveUp);
  },
};
