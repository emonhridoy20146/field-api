import type { ModuleManifest } from '../../core/module/types.js';
import { syncMutations } from './sync.js';
import { ctx } from '../../core/context/index.js';
import { indexMigration } from '../../core/db/migrations.js';
import { registerCashPositionProvider } from '../collections/index.js';
import { registerSummaryContributor } from '../handovers/index.js';
import { cashRoutes } from './routes.js';
import { getDeposit, onCollectionReceived, positionOf } from './service.js';

export const manifest: ModuleManifest = {
  name: 'cash',
  version: '1.0.0',
  description: 'Cash on hand, limits, deposits, verification, end-of-day closing (FR-CASH-*)',
  featureFlag: { key: 'module.cash', default: false, description: 'Cash on hand and deposits', owner: 'field-api' },
  dependsOn: ['audit', 'settings', 'users', 'collections', 'handovers'],
  permissions: [
    { key: 'cash.view', description: { en: 'View cash positions (own only for FS)', bn: 'হাতে নগদ দেখা' }, defaults: { super_admin: true, branch_manager: true, field_staff: true, viewer: true } },
    { key: 'cash.deposit.record', description: { en: 'Record a deposit', bn: 'জমা রেকর্ড' }, defaults: { super_admin: true, branch_manager: true, field_staff: true } },
    { key: 'cash.deposit.verify', description: { en: 'Verify/reject deposits', bn: 'জমা যাচাই' }, defaults: { super_admin: true, branch_manager: true } },
    { key: 'cash.limit.manage', description: { en: 'Set cash-on-hand limits per user/branch', bn: 'নগদ সীমা নির্ধারণ' }, defaults: { super_admin: true } },
  ],
  routes: cashRoutes,
  events: { emits: ['cash.deposit.recorded', 'cash.deposit.verified', 'cash.deposit.rejected', 'cash.limit_reached'], consumes: ['collection.received'] },
  settings: [
    { key: 'cash.limitPoisha', type: 'int', default: 5_000_000, branchOverridable: true, exposeToApp: true, description: 'FR-CASH-002 default limit (50,000 BDT); OD confirmation pending' },
    { key: 'cash.limitMode', type: 'enum', enum: ['warn', 'block'], default: 'warn', branchOverridable: true, exposeToApp: true, description: 'App behaviour at 100 % (server never rejects collections)' },
  ],
  inboxTypes: [{ type: 'cash.over_limit', severity: 'high' }, { type: 'cash.deposit.pending', severity: 'medium' }],
  notificationTypes: [{ type: 'cash.limit_reached' }, { type: 'cash.deposit.decided' }],
  syncEntities: [
    {
      entity: 'deposit',
      load: async (ids, user) => {
        const out = new Map<string, Record<string, unknown>>();
        for (const id of ids) await getDeposit(user, id).then((v) => out.set(id, v), () => undefined);
        return out;
      },
    },
  ],
  syncMutations,
  migrations: [
    indexMigration('20261115-0001-cash-indexes', [
      { collection: 'cash_deposits', key: { clientId: 1 }, options: { unique: true } },
      { collection: 'cash_deposits', key: { userId: 1, status: 1 } },
      { collection: 'cash_deposits', key: { branchId: 1, status: 1, depositedAt: -1 } },
      { collection: 'cash_closings', key: { userId: 1, businessDate: 1 }, options: { unique: true } },
    ]),
  ],
  init() {
    ctx().bus.on('collection.received', async (p) => onCollectionReceived(p as never));
    registerCashPositionProvider(async (userId) => positionOf(userId));
    // FR-HO-005: cash is not transferred by a handover; the summary shows what the sender still holds.
    registerSummaryContributor(async (p) => ({ cashOnHandPoisha: (await positionOf(p.fromUserId)).onHandPoisha }));
  },
};
