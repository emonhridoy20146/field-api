import type { ModuleManifest } from '../../core/module/types.js';
import { indexMigration } from '../../core/db/migrations.js';
import { userRoutes } from './routes.js';

export const manifest: ModuleManifest = {
  name: 'users',
  version: '1.0.0',
  core: true,
  description: 'FOS users (FR-USER-*)',
  dependsOn: ['audit'],
  permissions: [
    { key: 'user.view', description: { en: 'List/view users in scope', bn: 'ব্যবহারকারী দেখা' }, defaults: { super_admin: true, area_manager: true, branch_manager: true, viewer: true } },
    { key: 'user.manage', description: { en: 'Create/edit/deactivate users, reset password', bn: 'ব্যবহারকারী তৈরি/সম্পাদনা/নিষ্ক্রিয়' }, defaults: { super_admin: true }, neverFor: ['area_manager'] },
  ],
  routes: userRoutes,
  events: { emits: ['user.created', 'user.updated', 'user.deactivated', 'user.activated', 'user.password_reset'], consumes: [] },
  migrations: [
    indexMigration('20261115-0001-users-indexes', [
      { collection: 'users', key: { phone: 1 }, options: { unique: true } },
      { collection: 'users', key: { username: 1 }, options: { unique: true, sparse: true } },
      { collection: 'users', key: { employeeCode: 1 }, options: { unique: true } },
      { collection: 'users', key: { branchIds: 1, role: 1, active: 1 } },
    ]),
  ],
};
