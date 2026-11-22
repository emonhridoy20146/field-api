import type { ModuleManifest } from '../../core/module/types.js';
import { indexMigration } from '../../core/db/migrations.js';
import { raiseResyncFloor } from '../../core/changefeed/index.js';
import { placesRoutes } from './routes.js';
import { syncMutations } from './sync.js';
import * as s from './service.js';

export const manifest: ModuleManifest = {
  name: 'places',
  version: '1.0.0',
  description: 'Map places: text markers (name, icon, note) staff and the office put on the map; staff move requests approved by the office (FR-PLC-001..006)',
  // New modules start OFF (CLAUDE.md §5); the owner turns `module.places` on in admin → flags.
  featureFlag: { key: 'module.places', default: false, description: 'Map places (text markers on the map)', owner: 'field-api' },
  dependsOn: ['audit', 'rbac', 'users', 'branches'],
  permissions: [
    { key: 'place.view', description: { en: 'See map places (all branches)', bn: 'ম্যাপে জায়গার নাম দেখা (সব শাখা)' }, defaults: { super_admin: true, branch_manager: true, field_staff: true, viewer: true } },
    {
      key: 'place.create',
      description: { en: 'Add a place to the map, edit own places, ask for a place to be moved', bn: 'ম্যাপে জায়গা যোগ, নিজের জায়গা সম্পাদনা, সরানোর অনুরোধ' },
      defaults: { super_admin: true, branch_manager: true, field_staff: true },
    },
    {
      key: 'place.manage',
      description: { en: 'Edit, move or delete any place; approve or reject move requests', bn: 'যেকোনো জায়গা সম্পাদনা, সরানো, মুছে ফেলা; সরানোর অনুরোধ অনুমোদন' },
      defaults: { super_admin: true, branch_manager: true },
    },
  ],
  routes: placesRoutes,
  events: { emits: ['place.created', 'place.updated', 'place.moved', 'place.move_requested', 'place.move_decided', 'place.deleted'], consumes: [] },
  inboxTypes: [{ type: 'place.move_request', severity: 'low' }],
  notificationTypes: [{ type: 'place.move_request' }, { type: 'place.move_decided' }],
  syncEntities: [{ entity: 'place', load: s.syncLoad, snapshot: s.snapshot }],
  syncMutations,
  migrations: [
    indexMigration('20261122-0001-places-indexes', [
      { collection: 'map_places', key: { branchId: 1, status: 1, _id: -1 } },
      { collection: 'map_places', key: { point: '2dsphere' } },
      { collection: 'map_places', key: { status: 1, 'pendingMove.requestedAt': 1 }, options: { partialFilterExpression: { 'pendingMove.requestedAt': { $exists: true } } } },
      { collection: 'map_places', key: { createdBy: 1, clientId: 1 }, options: { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } } },
    ]),
    // 1.42.0 (ADR-054): lists and the office queue now filter by status only, no longer by branch.
    indexMigration('20261122-0002-places-status-index', [{ collection: 'map_places', key: { status: 1, _id: -1 } }]),
  ],
  async init() {
    // ADR-054: places are shared by every branch; phones that took their snapshot when they held only their branch's
    // places reload once, so they also get the places of other branches.
    await raiseResyncFloor('places-all-branches');
  },
};
