import type { ModuleManifest } from '../../core/module/types.js';
import { indexMigration } from '../../core/db/migrations.js';
import { __camel__Routes } from './routes.js';

export const manifest: ModuleManifest = {
  name: '__name__',
  version: '0.1.0',
  description: 'TODO: one line + FR ids',
  // New modules start OFF (CLAUDE.md §5).
  featureFlag: { key: 'module.__name__', default: false, description: 'TODO', owner: 'field-api' },
  dependsOn: ['audit'],
  permissions: [
    // Add every key to docs/02-requirements.md §3.1 as well; `pnpm check:permissions` compares both.
    // { key: '__name__.view', description: { en: 'TODO', bn: 'TODO' }, defaults: { super_admin: true } },
  ],
  routes: __camel__Routes,
  events: { emits: [], consumes: [] },
  migrations: [indexMigration('00000000-0001-__name__-indexes', [{ collection: '__collection__', key: { branchId: 1, createdAt: -1 } }])],
};
