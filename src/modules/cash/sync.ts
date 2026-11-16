import { z } from 'zod';
import type { SyncMutationDef } from '../../core/module/types.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

export const syncMutations: SyncMutationDef[] = [
  {
    entity: 'deposit',
    permission: 'cash.deposit.record',
    apply: async (user, payload, m) => {
      const key = parse(z.object({ idempotencyKey: z.string().uuid().optional() }), payload).idempotencyKey ?? m.mutationId;
      const r = await s.createDeposit(user, key, parse(s.depositSchema, payload), m.meta);
      const b = r.body as { id: string; status: string };
      return { entityId: b.id, replayed: r.replayed, status: b.status };
    },
  },
  {
    entity: 'cash_closing',
    permission: 'cash.deposit.record',
    apply: async (user, payload) => {
      const p = parse(z.object({ businessDate: z.string().max(10), note: z.string().max(500).optional() }), payload);
      await s.close(user, p);
      return { entityId: `${user.id}:${p.businessDate}` };
    },
  },
];
