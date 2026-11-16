import type { ModuleManifest } from '../../core/module/types.js';
import { syncMutations } from './sync.js';
import { ctx } from '../../core/context/index.js';
import { indexMigration } from '../../core/db/migrations.js';
import { tagRoutes } from './routes.js';
import { onBalanceCleared } from './service.js';

export const manifest: ModuleManifest = {
  name: 'tags',
  version: '1.0.0',
  description: 'Bad-customer tag, history, approval mode and balance-cleared reviews (FR-TAG-*)',
  featureFlag: { key: 'module.tags', default: false, description: 'Bad-customer tagging', owner: 'field-api' },
  dependsOn: ['audit', 'settings', 'rbac', 'users', 'customers'],
  permissions: [
    { key: 'tag.view', description: { en: 'See bad-customer suggestion, tag and history', bn: 'খারাপ গ্রাহক ট্যাগ ও ইতিহাস দেখা' }, defaults: { super_admin: true, branch_manager: true, field_staff: true, viewer: true } },
    { key: 'tag.set', description: { en: 'Tag/untag a customer (reason required)', bn: 'গ্রাহক ট্যাগ/আনট্যাগ (কারণসহ)' }, defaults: { super_admin: true, branch_manager: true, field_staff: true } },
    { key: 'tag.approve', description: { en: 'Review staff tags and balance-cleared prompts', bn: 'ট্যাগ পর্যালোচনা ও অনুমোদন' }, defaults: { super_admin: true, branch_manager: true } },
  ],
  routes: tagRoutes,
  events: { emits: ['tag.changed', 'tag.review_requested', 'tag.review_decided'], consumes: ['customer.balance_cleared'] },
  settings: [{ key: 'tags.requireApproval', type: 'bool', default: false, branchOverridable: true, exposeToApp: true, description: 'FR-TAG-007 staff tags need approval' }],
  inboxTypes: [{ type: 'tag.review', severity: 'medium' }],
  notificationTypes: [{ type: 'tag.balance_cleared' }, { type: 'tag.review_requested' }, { type: 'tag.review_decided' }],
  syncMutations,
  migrations: [
    indexMigration('20261115-0001-tags-indexes', [
      { collection: 'tag_events', key: { customerId: 1, at: -1 } },
      { collection: 'tag_reviews', key: { status: 1, branchId: 1, createdAt: 1 } },
      { collection: 'tag_reviews', key: { customerId: 1, kind: 1, status: 1 } },
    ]),
  ],
  init() {
    ctx().bus.on('customer.balance_cleared', async (p) => onBalanceCleared(p as { customerId: string; branchId: string | null; tagged: boolean }));
  },
};
