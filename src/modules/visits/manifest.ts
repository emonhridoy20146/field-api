import type { ModuleManifest } from '../../core/module/types.js';
import { syncMutations } from './sync.js';
import { indexMigration } from '../../core/db/migrations.js';
import type { AuthUser } from '../../core/security/types.js';
import { registerDetailContributor, registerListEnricher, registerTimelineSource } from '../customers/index.js';
import { visitRoutes } from './routes.js';
import * as s from './service.js';

export const manifest: ModuleManifest = {
  name: 'visits',
  version: '1.0.0',
  description: 'Customer visits: check-in/out with GPS, outcome, photos (FR-VIS-001..004)',
  featureFlag: { key: 'module.visits', default: false, description: 'Visits', owner: 'field-api' },
  dependsOn: ['settings', 'users', 'customers'],
  permissions: [
    { key: 'visit.record', description: { en: 'Check in / out at a customer', bn: 'গ্রাহকের কাছে ভিজিট রেকর্ড' }, defaults: { super_admin: true, branch_manager: true, field_staff: true } },
    { key: 'visit.view', description: { en: 'View visits in scope', bn: 'ভিজিট দেখা' }, defaults: { super_admin: true, branch_manager: true, field_staff: true, viewer: true } },
  ],
  routes: visitRoutes,
  events: { emits: ['visit.recorded'], consumes: [] },
  inboxTypes: [{ type: 'visit.flagged', severity: 'low' }],
  syncEntities: [
    {
      entity: 'visit',
      load: async (ids: string[], user: AuthUser) => {
        const out = new Map<string, Record<string, unknown>>();
        for (const id of ids) await s.get(user, id).then((v) => out.set(id, v), () => undefined);
        return out;
      },
      snapshot: s.syncSnapshot,
    },
  ],
  syncMutations,
  migrations: [
    indexMigration('20261115-0001-visits-indexes', [
      { collection: 'visits', key: { clientId: 1 }, options: { unique: true } },
      { collection: 'visits', key: { customerId: 1, checkInAt: -1 } },
      { collection: 'visits', key: { userId: 1, checkInAt: -1 } },
      { collection: 'visits', key: { branchId: 1, checkInAt: -1 } },
    ]),
    indexMigration('20261116-0001-visits-cowork-indexes', [
      { collection: 'visits', key: { 'coWork.sessionId': 1 }, options: { sparse: true } },
      { collection: 'visits', key: { 'coWork.participantIds': 1, checkInAt: -1 }, options: { sparse: true } },
    ]),
  ],
  init() {
    registerListEnricher(async (ids) => new Map([...(await s.lastVisits(ids))].map(([k, v]) => [k, { lastVisitAt: v.toISOString() }])));
    registerDetailContributor(async (c) => ({ lastVisit: await s.lastVisitOf(c.id) }));
    registerTimelineSource(async (customerId, _u, before, limit) => s.timelineItems(customerId, before, limit));
  },
};
