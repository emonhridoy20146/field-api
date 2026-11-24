import type { ModuleManifest } from '../../core/module/types.js';
import { indexMigration } from '../../core/db/migrations.js';
import { taskRoutes } from './routes.js';
import { syncMutations } from './sync.js';
import * as s from './service.js';

export const manifest: ModuleManifest = {
  name: 'tasks',
  version: '1.0.0',
  description: 'Free-form tasks an admin gives to field staff with a note: notify, resolve request, admin verification (FR-TASK-001..005)',
  // New modules start OFF (CLAUDE.md §5).
  featureFlag: { key: 'module.tasks', default: false, description: 'Admin tasks for staff', owner: 'field-api' },
  dependsOn: ['audit', 'users', 'branches'],
  permissions: [
    { key: 'task.view', description: { en: 'View staff tasks in scope', bn: 'স্টাফের কাজ দেখা' }, defaults: { super_admin: true, area_manager: true, branch_manager: true, viewer: true } },
    { key: 'task.manage', description: { en: 'Give tasks to staff, edit, cancel, verify or reject a resolve request', bn: 'স্টাফকে কাজ দেওয়া, যাচাই বা বাতিল' }, defaults: { super_admin: true, area_manager: true, branch_manager: true } },
    { key: 'task.work', description: { en: 'See own tasks and ask for them to be resolved', bn: 'নিজের কাজ দেখা ও সমাধানের অনুরোধ' }, defaults: { field_staff: true } },
  ],
  routes: taskRoutes,
  events: { emits: ['task.assigned', 'task.resolve_requested', 'task.verified', 'task.rejected', 'task.cancelled'], consumes: [] },
  notificationTypes: [{ type: 'task.assigned' }, { type: 'task.resolve_requested' }, { type: 'task.decided' }],
  inboxTypes: [{ type: 'task.resolve_requested', severity: 'medium' }],
  syncEntities: [{ entity: 'task', load: s.syncLoad, snapshot: async (user) => ({ items: (await s.mine(user)).items, nextCursor: null }) }],
  syncMutations,
  migrations: [
    indexMigration('20261118-0001-tasks-indexes', [
      { collection: 'staff_tasks', key: { assigneeId: 1, status: 1, _id: -1 } },
      { collection: 'staff_tasks', key: { branchId: 1, status: 1, _id: -1 } },
      { collection: 'staff_tasks', key: { status: 1, dueDate: 1 } },
      { collection: 'staff_tasks', key: { createdBy: 1, clientId: 1 }, options: { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } } },
    ]),
  ],
};
