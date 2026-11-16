import { z } from 'zod';
import type { SyncMutationDef } from '../../core/module/types.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';
import { proposalBody } from './routes.js';

export const syncMutations: SyncMutationDef[] = [
  {
    entity: 'location_proposal',
    permission: 'customer.location.propose',
    apply: async (user, payload, m) => {
      const r = await s.proposeLocation(user, parse(z.object({ customerId: z.string().max(64) }), payload).customerId, parse(proposalBody, payload), m.meta);
      return { entityId: r.id, replayed: r.replayed, status: r.status };
    },
  },
];
