import type { ModuleManifest } from '../../core/module/types.js';
import { searchRoutes } from './routes.js';

export const manifest: ModuleManifest = {
  name: 'search',
  version: '1.0.0',
  description: 'Global search across customers, staff and receipts (FR-SRCH-001)',
  featureFlag: { key: 'module.search', default: false, description: 'Global search', owner: 'field-api' },
  dependsOn: ['flags', 'users', 'customers', 'collections'],
  permissions: [],
  routes: searchRoutes,
};
