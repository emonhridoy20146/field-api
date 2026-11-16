import { z } from 'zod';
import type { SyncMutationDef } from '../../core/module/types.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';
import { tagBody } from './routes.js';

export const syncMutations: SyncMutationDef[] = [
  {
    entity: 'tag',
    permission: 'tag.set',
    apply: async (user, payload, m) => {
      const p = parse(z.object({ customerId: z.string().max(64), ifMatch: z.number().int().min(0).optional() }), payload);
      const r = await s.setTag(user, p.customerId, parse(tagBody, payload), p.ifMatch ?? null, m.meta);
      return { entityId: p.customerId, status: String(r.tag.state), extra: { eventId: r.eventId } };
    },
  },
];
