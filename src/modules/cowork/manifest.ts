import type { ModuleManifest } from '../../core/module/types.js';
import { ctx } from '../../core/context/index.js';
import { indexMigration } from '../../core/db/migrations.js';
import { registerCoWorkResolver } from '../visits/index.js';
import { coworkRoutes } from './routes.js';
import * as s from './service.js';

export const manifest: ModuleManifest = {
  name: 'cowork',
  version: '1.0.0',
  description: 'Staff working together: invite, accept, joint visits and their credit (FR-CW-001..005)',
  // New modules start OFF (CLAUDE.md §5).
  featureFlag: { key: 'module.cowork', default: false, description: 'Co-work sessions and joint visits', owner: 'field-api' },
  dependsOn: ['audit', 'settings', 'users', 'visits', 'attendance'],
  permissions: [
    { key: 'cowork.use', description: { en: 'Ask colleagues to work together and answer such requests', bn: 'সহকর্মীর সাথে যৌথ কাজের অনুরোধ ও উত্তর' }, defaults: { field_staff: true } },
    { key: 'cowork.view', description: { en: 'View co-work sessions in scope', bn: 'যৌথ কাজের সেশন দেখা' }, defaults: { super_admin: true, area_manager: true, branch_manager: true, viewer: true } },
    { key: 'cowork.manage', description: { en: 'End a co-work session with a reason', bn: 'কারণসহ যৌথ কাজ বন্ধ করা' }, defaults: { super_admin: true, area_manager: true, branch_manager: true } },
  ],
  routes: coworkRoutes,
  events: { emits: ['cowork.requested', 'cowork.responded', 'cowork.ended', 'cowork.cancelled'], consumes: ['attendance.event', 'attendance.auto_closed'] },
  settings: [
    { key: 'cowork.visitCredit', type: 'number', default: 1, branchOverridable: true, exposeToApp: true, description: 'FR-CW-005 how much a joint visit counts for each participant in visit targets (0 to 1). Money is never shared.' },
    { key: 'cowork.maxMembers', type: 'int', default: 5, branchOverridable: true, exposeToApp: true, description: 'FR-CW-001 largest group that can work together' },
  ],
  jobs: [{ name: 'cowork.end-day', schedule: '5 0 * * *', handler: async () => void (await s.endPastSessions()) }],
  notificationTypes: [{ type: 'cowork.requested' }, { type: 'cowork.responded' }, { type: 'cowork.ended' }, { type: 'cowork.cancelled' }],
  syncEntities: [{ entity: 'cowork_session', load: s.syncLoad, snapshot: async (user) => ({ items: await s.mine(user), nextCursor: null }) }],
  migrations: [
    indexMigration('20261116-0001-cowork-indexes', [
      { collection: 'cowork_sessions', key: { 'members.userId': 1, businessDate: -1 } },
      { collection: 'cowork_sessions', key: { branchId: 1, businessDate: -1 } },
      { collection: 'cowork_sessions', key: { status: 1, businessDate: 1 } },
      { collection: 'cowork_sessions', key: { clientIds: 1 } },
    ]),
  ],
  init() {
    registerCoWorkResolver(s.resolveParticipants);
    const { bus } = ctx();
    bus.on('attendance.event', async (p) => {
      if (p.type === 'work_out') await s.onWorkEnded(p.userId as string, p.at as Date);
    });
    bus.on('attendance.auto_closed', async (p) => s.onWorkEnded(p.userId as string, ctx().clock.now()));
  },
};
