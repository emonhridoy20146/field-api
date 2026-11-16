import { z } from 'zod';
import type { SyncMutationDef } from '../../core/module/types.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

export const syncMutations: SyncMutationDef[] = [
  {
    entity: 'visit',
    permission: 'visit.record',
    apply: async (user, payload) => {
      const r = await s.create(user, parse(s.createSchema, payload));
      return { entityId: r.body.id, replayed: r.statusCode === 200 };
    },
  },
  {
    entity: 'visit_checkout',
    permission: 'visit.record',
    apply: async (user, payload) => {
      // The app may only know its own clientId when the visit was created offline in the same batch.
      const p = parse(z.object({ visitId: z.string().max(64).optional(), visitClientId: z.string().uuid().optional(), checkOutAt: z.string().datetime({ offset: true }), outcome: z.enum(s.OUTCOMES).optional() }).refine((x) => x.visitId || x.visitClientId, { message: 'visitId or visitClientId required', path: ['visitId'] }), payload);
      const id = p.visitId ?? (await s.idByClientId(user, p.visitClientId!));
      const v = await s.checkout(user, id, { checkOutAt: p.checkOutAt, outcome: p.outcome });
      return { entityId: v.id };
    },
  },
];
