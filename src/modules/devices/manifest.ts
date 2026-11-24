import type { ModuleManifest } from '../../core/module/types.js';
import { indexMigration } from '../../core/db/migrations.js';
import { registerLoginGuard } from '../auth/index.js';
import { deviceRoutes } from './routes.js';
import { loginGuard } from './service.js';

export const manifest: ModuleManifest = {
  name: 'devices',
  version: '1.0.0',
  description: 'Device binding, approval and remote unbind (FR-AUTH-007) [ADDED]',
  featureFlag: { key: 'module.devices', default: false, description: 'One active device per field staff', owner: 'field-api' },
  dependsOn: ['audit', 'users', 'flags', 'settings', 'auth'],
  permissions: [
    { key: 'device.manage', description: { en: 'View devices, revoke sessions, unbind device', bn: 'ডিভাইস ব্যবস্থাপনা' }, defaults: { super_admin: true, branch_manager: true } },
  ],
  routes: deviceRoutes,
  events: { emits: ['device.bound', 'device.unbound', 'device.approval_requested'], consumes: ['auth.login'] },
  settings: [
    { key: 'devices.maxPerUser', type: 'int', default: 1, description: 'OD-10' },
    { key: 'devices.bindRoles', type: 'json', default: ['field_staff'] },
    {
      key: 'devices.reinstallHintIdleDays',
      type: 'int',
      default: 0,
      description:
        'FR-AUTH-007 (1.47.0) mark a pending device likelyReinstall when it reports the same model and Android version as the user\'s only active device and that device was not seen for this many days. 0 = off. Only a hint: an admin still approves.',
    },
  ],
  inboxTypes: [{ type: 'device.approval_requested', severity: 'medium' }],
  migrations: [
    indexMigration('20261115-0001-devices-indexes', [
      { collection: 'devices', key: { deviceId: 1 }, options: { unique: true } },
      { collection: 'devices', key: { userId: 1, status: 1 } },
      { collection: 'devices', key: { fcmToken: 1 }, options: { sparse: true } },
    ]),
  ],
  init() {
    registerLoginGuard(loginGuard);
  },
};
