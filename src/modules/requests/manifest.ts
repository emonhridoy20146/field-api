import type { ModuleManifest } from '../../core/module/types.js';
import { indexMigration } from '../../core/db/migrations.js';
import { requestRoutes } from './routes.js';
import { syncMutations } from './sync.js';
import * as s from './service.js';

export const manifest: ModuleManifest = {
  name: 'requests',
  version: '1.0.0',
  description: 'Requests / tickets from staff with a traced, append-only timeline: area manager and super admin queues, forward, assign, resolve (FR-REQ-001..006, ADR-066)',
  // New modules start OFF (CLAUDE.md §5); the owner turns `module.requests` on in admin → flags.
  featureFlag: { key: 'module.requests', default: false, description: 'Requests / tickets (staff → area managers → super admin)', owner: 'field-api' },
  dependsOn: ['audit', 'rbac', 'users', 'branches', 'customers', 'media'],
  permissions: [
    {
      key: 'request.create',
      description: { en: 'Send requests, reports and complaints; see your own and those assigned to you', bn: 'অনুরোধ, রিপোর্ট ও অভিযোগ পাঠানো; নিজের ও নিজেকে দেওয়া গুলো দেখা' },
      defaults: { super_admin: true, area_manager: true, branch_manager: true, field_staff: true },
    },
    { key: 'request.view', description: { en: 'See requests in scope and comment on them', bn: 'আওতাধীন অনুরোধ দেখা ও মন্তব্য করা' }, defaults: { super_admin: true, area_manager: true, branch_manager: true, viewer: true } },
    {
      key: 'request.manage',
      description: { en: 'Work the area manager queue: forward, assign, resolve, close, reopen', bn: 'এরিয়া ম্যানেজারের সারি: ফরোয়ার্ড, দায়িত্ব দেওয়া, সমাধান, বন্ধ, পুনরায় খোলা' },
      defaults: { super_admin: true, area_manager: true },
    },
    {
      key: 'request.important.manage',
      description: { en: 'Work the super admin queue: receive important requests, move, resolve or close them', bn: 'সুপার অ্যাডমিনের সারি: জরুরি অনুরোধ পাওয়া ও সমাধান' },
      defaults: { super_admin: true },
    },
  ],
  routes: requestRoutes,
  events: {
    emits: ['request.created', 'request.commented', 'request.forwarded', 'request.assigned', 'request.resolved', 'request.reopened', 'request.closed', 'request.top_waiting', 'request.top_cleared'],
    consumes: [],
  },
  notificationTypes: [
    { type: 'request.created' },
    { type: 'request.important' },
    { type: 'request.forwarded' },
    { type: 'request.assigned' },
    { type: 'request.commented' },
    { type: 'request.resolved' },
    { type: 'request.reopened' },
    { type: 'request.closed' },
  ],
  inboxTypes: [{ type: 'request.important', severity: 'high' }],
  syncEntities: [{ entity: 'request', load: s.syncLoad, snapshot: s.snapshot }],
  syncMutations,
  migrations: [
    indexMigration('20261124-0001-requests-indexes', [
      { collection: 'requests', key: { clientId: 1 }, options: { unique: true } },
      { collection: 'requests', key: { branchId: 1, status: 1, _id: -1 } },
      { collection: 'requests', key: { status: 1, currentQueue: 1, _id: -1 } },
      { collection: 'requests', key: { 'createdBy.id': 1, _id: -1 } },
      { collection: 'requests', key: { 'assignee.id': 1, status: 1 } },
      { collection: 'requests', key: { createdDate: 1 } },
    ]),
  ],
};
