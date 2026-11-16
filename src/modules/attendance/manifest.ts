import type { ModuleManifest } from '../../core/module/types.js';
import { syncMutations } from './sync.js';
import { indexMigration } from '../../core/db/migrations.js';
import type { AuthUser } from '../../core/security/types.js';
import { attendanceRoutes } from './routes.js';
import * as s from './service.js';

export const manifest: ModuleManifest = {
  name: 'attendance',
  version: '1.0.0',
  description: 'Work-in/out, breaks, derived days, corrections, auto-close and leave (FR-ATT-001..008)',
  featureFlag: { key: 'module.attendance', default: false, description: 'Attendance', owner: 'field-api' },
  dependsOn: ['audit', 'settings', 'users'],
  permissions: [
    { key: 'attendance.record', description: { en: 'Own work-in/out and breaks', bn: 'নিজের হাজিরা' }, defaults: { field_staff: true } },
    { key: 'attendance.view', description: { en: 'View attendance of others in scope', bn: 'হাজিরা দেখা' }, defaults: { super_admin: true, branch_manager: true, viewer: true } },
    { key: 'attendance.manage', description: { en: 'Corrections, leave approval, shift assignment', bn: 'হাজিরা সংশোধন ও ছুটি অনুমোদন' }, defaults: { super_admin: true, branch_manager: true } },
    { key: 'leave.request', description: { en: 'Request leave', bn: 'ছুটির আবেদন' }, defaults: { field_staff: true } },
  ],
  routes: attendanceRoutes,
  events: { emits: ['attendance.event', 'attendance.corrected', 'attendance.auto_closed', 'attendance.absent', 'leave.requested', 'leave.decided'], consumes: [] },
  settings: [{ key: 'attendance.selfieRequired', type: 'bool', default: false, branchOverridable: true, exposeToApp: true, description: 'FR-ATT-001 require a selfie at work-in (missing selfie is flagged, not rejected)' }],
  jobs: [
    { name: 'attendance.auto-close', schedule: '*/15 * * * *', handler: async () => void (await s.autoClose()) },
    { name: 'attendance.finalize', schedule: '15 0 * * *', handler: async () => void (await s.finalize()) },
  ],
  notificationTypes: [{ type: 'attendance.auto_closed' }, { type: 'leave.decided' }],
  inboxTypes: [{ type: 'attendance.absent', severity: 'low' }, { type: 'leave.requested', severity: 'low' }],
  syncEntities: [
    {
      entity: 'attendance_day',
      // entityId is `${userId}:${businessDate}`; a user only ever loads their own days.
      load: async (ids: string[], user: AuthUser) => {
        const out = new Map<string, Record<string, unknown>>();
        for (const id of ids) {
          const [userId, date] = id.split(':');
          if (userId === user.id && date) out.set(id, await s.dayOf(user, date));
        }
        return out;
      },
    },
  ],
  syncMutations,
  migrations: [
    indexMigration('20261115-0001-attendance-indexes', [
      { collection: 'attendance_events', key: { clientId: 1 }, options: { unique: true } },
      { collection: 'attendance_events', key: { userId: 1, businessDate: 1, at: 1 } },
      { collection: 'attendance_days', key: { userId: 1, businessDate: 1 }, options: { unique: true } },
      { collection: 'attendance_days', key: { branchId: 1, businessDate: 1 } },
      { collection: 'attendance_days', key: { closed: 1, state: 1 } },
      { collection: 'leave_requests', key: { userId: 1, from: 1 } },
      { collection: 'leave_requests', key: { branchId: 1, status: 1, createdAt: -1 } },
    ]),
  ],
};
