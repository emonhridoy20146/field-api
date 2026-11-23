import type { SyncMutationDef } from '../../core/module/types.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

/** Offline create from the app (1.45.0): same body and rules as POST /prospects, idempotent by clientId. */
export const syncMutations: SyncMutationDef[] = [
  {
    entity: 'prospect',
    permission: 'prospect.create',
    apply: async (user, payload, { meta }) => {
      const r = await s.create(user, parse(s.createSchema, payload), meta);
      return { entityId: r.body.id, replayed: r.statusCode === 200, status: r.body.status, extra: { version: r.body.version } };
    },
  },
];
