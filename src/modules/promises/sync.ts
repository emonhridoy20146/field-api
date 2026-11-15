import { z } from 'zod';
import type { SyncMutationDef } from '../../core/module/types.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

export const syncMutations: SyncMutationDef[] = [
  {
    entity: 'promise',
    permission: 'promise.create',
    apply: async (user, payload) => {
      const r = await s.create(user, parse(s.createSchema, payload));
      return { entityId: r.body.id, replayed: r.statusCode === 200, status: r.body.status };
    },
  },
  {
    entity: 'promise_cancel',
    permission: 'promise.create',
    apply: async (user, payload) => {
      const p = parse(z.object({ promiseId: z.string().max(64), reason: z.string().trim().min(5).max(500) }), payload);
      const r = await s.cancel(user, p.promiseId, p.reason);
      return { entityId: r.id, status: r.status };
    },
  },
];
