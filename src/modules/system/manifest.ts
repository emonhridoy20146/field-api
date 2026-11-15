import type { ModuleManifest } from '../../core/module/types.js';
import { ctx } from '../../core/context/index.js';
import { getSetting } from '../settings/index.js';
import { systemRoutes } from './routes.js';

export const manifest: ModuleManifest = {
  name: 'system',
  version: '1.0.0',
  core: true,
  description: 'Health, app config and version gate (FR-AUTH-009)',
  dependsOn: ['settings', 'erp-gateway'],
  permissions: [],
  routes: systemRoutes,
  init() {
    ctx().ports.minAppVersion = () => getSetting<string>('app.minVersion');
  },
};
