import type { ModuleManifest } from '../../core/module/types.js';
import { indexMigration } from '../../core/db/migrations.js';
import { CONSUMED_EVENTS, subscribe } from './events.js';
import { inboxRoutes } from './routes.js';

export const manifest: ModuleManifest = {
  name: 'inbox',
  version: '1.0.0',
  description: '"Needs attention" exceptions inbox fed by domain events (FR-INB-001)',
  featureFlag: { key: 'module.inbox', default: false, description: 'Exceptions inbox', owner: 'field-api' },
  dependsOn: ['audit', 'rbac'],
  permissions: [{ key: 'inbox.view', description: { en: '"Needs attention" exceptions inbox', bn: 'জরুরি বিষয়ের ইনবক্স' }, defaults: { super_admin: true, branch_manager: true } }],
  routes: inboxRoutes,
  events: { emits: [], consumes: CONSUMED_EVENTS },
  inboxTypes: [
    { type: 'tag.review', severity: 'medium' },
    { type: 'location.proposal', severity: 'low' },
  ],
  migrations: [
    indexMigration('20261115-0001-inbox-indexes', [
      { collection: 'inbox_items', key: { key: 1 }, options: { unique: true } },
      { collection: 'inbox_items', key: { branchId: 1, status: 1, severityRank: -1, _id: -1 } },
    ]),
  ],
  init() {
    subscribe();
  },
};
