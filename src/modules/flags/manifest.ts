import type { ModuleManifest } from '../../core/module/types.js';
import { ctx } from '../../core/context/index.js';
import { flagRoutes } from './routes.js';
import { isEnabledForUser } from './service.js';

export const manifest: ModuleManifest = {
  name: 'flags',
  version: '1.0.0',
  core: true,
  description: 'In-house feature flags, global default OFF with per-branch overrides (ADR-015)',
  dependsOn: ['audit', 'settings'],
  permissions: [
    { key: 'flag.manage', description: { en: 'Toggle feature flags', bn: 'ফিচার ফ্ল্যাগ চালু/বন্ধ' }, defaults: { super_admin: true }, neverFor: ['area_manager'] },
  ],
  routes: flagRoutes,
  events: { emits: ['flag.changed'], consumes: [] },
  init() {
    ctx().ports.flagEnabled = isEnabledForUser;
  },
};
