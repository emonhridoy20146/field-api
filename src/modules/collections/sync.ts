import { z } from 'zod';
import type { SyncMutationDef } from '../../core/module/types.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

/** Offline collection: the client's idempotencyKey (or, failing that, its mutationId) is the money key — never a server one. */
export const syncMutations: SyncMutationDef[] = [
  {
    entity: 'collection',
    permission: 'collection.record',
    apply: async (user, payload, m) => {
      const key = parse(z.object({ idempotencyKey: z.string().uuid().optional() }), payload).idempotencyKey ?? m.mutationId;
      const r = await s.record(user, key, parse(s.createSchema, payload), m.meta);
      const b = r.body as { id: string; status: string; receiptNo?: string; conflict?: { code: string; message?: { en: string; bn: string } } | null };
      return { entityId: b.id, replayed: r.replayed, status: b.status, ...(b.conflict ? { conflict: { code: b.conflict.code, ...(b.conflict.message ? { message: b.conflict.message } : {}) } } : {}), extra: { receiptNo: b.receiptNo } };
    },
  },
];
