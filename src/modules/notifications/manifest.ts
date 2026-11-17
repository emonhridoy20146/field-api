import type { ModuleManifest } from '../../core/module/types.js';
import { indexMigration } from '../../core/db/migrations.js';
import type { AuthUser } from '../../core/security/types.js';
import { CONSUMED_EVENTS, subscribe } from './events.js';
import { notificationRoutes } from './routes.js';
import { syncMutations } from './sync.js';
import * as s from './service.js';

const loader = (get: (u: AuthUser, id: string) => Promise<Record<string, unknown>>) => async (ids: string[], user: AuthUser) => {
  const out = new Map<string, Record<string, unknown>>();
  for (const id of ids) await get(user, id).then((v) => out.set(id, v), () => undefined);
  return out;
};

export const manifest: ModuleManifest = {
  name: 'notifications',
  version: '1.0.0',
  description: 'Notification center, push with quiet hours, broadcasts (FR-NOT-001..005)',
  featureFlag: { key: 'module.notifications', default: false, description: 'Notifications and announcements', owner: 'field-api' },
  dependsOn: ['audit', 'settings', 'users', 'devices', 'rbac'],
  permissions: [{ key: 'notification.broadcast', description: { en: 'Send announcements to staff in scope', bn: 'কর্মীদের ঘোষণা পাঠানো' }, defaults: { super_admin: true, branch_manager: true } }],
  routes: notificationRoutes,
  events: { emits: [], consumes: CONSUMED_EVENTS },
  settings: [{ key: 'notifications.quietHours', type: 'json', default: { start: '21:00', end: '08:00' }, exposeToApp: true, description: 'FR-NOT-004 no push in this Dhaka window except critical types' }],
  notificationTypes: [{ type: 'announcement' }, { type: 'tag.review' }, { type: 'location.proposal.decided' }, { type: 'leave.requested' }],
  syncEntities: [
    { entity: 'notification', load: loader(s.get) },
    { entity: 'broadcast', load: loader(s.getBroadcastFor) },
  ],
  syncMutations,
  migrations: [
    indexMigration('20261115-0001-notifications-indexes', [
      { collection: 'notifications', key: { userId: 1, _id: -1 } },
      { collection: 'notifications', key: { userId: 1, readAt: 1 } },
      { collection: 'notifications', key: { createdAt: 1 }, options: { expireAfterSeconds: 90 * 86_400 } },
      { collection: 'broadcasts', key: { recipientIds: 1, _id: -1 } },
    ]),
  ],
  init() {
    subscribe();
  },
};
