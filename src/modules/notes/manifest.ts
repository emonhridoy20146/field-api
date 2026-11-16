import type { ModuleManifest } from '../../core/module/types.js';
import { syncMutations } from './sync.js';
import { indexMigration } from '../../core/db/migrations.js';
import type { AuthUser } from '../../core/security/types.js';
import { registerDetailContributor, registerTimelineSource } from '../customers/index.js';
import { noteRoutes } from './routes.js';
import * as s from './service.js';

const loader = (get: (u: AuthUser, id: string) => Promise<Record<string, unknown>>) => async (ids: string[], user: AuthUser) => {
  const out = new Map<string, Record<string, unknown>>();
  for (const id of ids) await get(user, id).then((v) => out.set(id, v), () => undefined);
  return out;
};

export const manifest: ModuleManifest = {
  name: 'notes',
  version: '1.0.0',
  description: 'Customer notes (15-min edit window) and call/SMS contact attempts (FR-NOTE-001, FR-M-014)',
  featureFlag: { key: 'module.notes', default: false, description: 'Notes and contact attempts', owner: 'field-api' },
  dependsOn: ['users', 'customers'],
  permissions: [
    { key: 'note.create', description: { en: 'Add notes', bn: 'নোট যোগ' }, defaults: { super_admin: true, branch_manager: true, field_staff: true } },
    { key: 'note.view', description: { en: 'View notes in scope', bn: 'নোট দেখা' }, defaults: { super_admin: true, branch_manager: true, field_staff: true, viewer: true } },
  ],
  routes: noteRoutes,
  events: { emits: ['note.created'], consumes: [] },
  syncEntities: [
    { entity: 'note', load: loader(s.getNote) },
    { entity: 'contact_attempt', load: loader(s.getContact) },
  ],
  syncMutations,
  migrations: [
    indexMigration('20261115-0001-notes-indexes', [
      { collection: 'notes', key: { clientId: 1 }, options: { unique: true } },
      { collection: 'notes', key: { customerId: 1, createdAt: -1 } },
      { collection: 'contact_attempts', key: { clientId: 1 }, options: { unique: true } },
      { collection: 'contact_attempts', key: { customerId: 1, at: -1 } },
      { collection: 'contact_attempts', key: { userId: 1, at: -1 } },
    ]),
  ],
  init() {
    registerDetailContributor(async (c) => ({ recentNotes: await s.recentNotes(c.id) }));
    registerTimelineSource(async (customerId, _u, before, limit) => s.timelineItems(customerId, before, limit));
  },
};
