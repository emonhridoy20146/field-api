import { z } from 'zod';
import type { SyncMutationDef } from '../../core/module/types.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';
import { addPhonesBody, proposalBody } from './routes.js';

export const syncMutations: SyncMutationDef[] = [
  {
    entity: 'location_proposal',
    permission: 'customer.location.propose',
    apply: async (user, payload, m) => {
      const r = await s.proposeLocation(user, parse(z.object({ customerId: z.string().max(64) }), payload).customerId, parse(proposalBody, payload), m.meta);
      return { entityId: r.id, replayed: r.replayed, status: r.status };
    },
  },
  {
    // 1.23.0 (FR-CUS-016): numbers typed on the phone, also offline. A repeat adds nothing.
    entity: 'customer_phone',
    permission: 'customer.phone.manage',
    apply: async (user, payload, m) => {
      const customerId = parse(z.object({ customerId: z.string().max(64) }), payload).customerId;
      const r = await s.addPhones(user, customerId, parse(addPhonesBody, payload).phones, m.meta);
      return { entityId: customerId, replayed: r.added.length === 0 };
    },
  },
];
