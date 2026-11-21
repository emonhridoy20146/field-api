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
  {
    // 1.32.0 (FR-COL-016): the collector deletes their own cash collection before it is deposited. Resolved by the server id,
    // or by the clientId when the collection was sent in the same batch (the app sends this after the collection).
    entity: 'collection_withdraw',
    permission: 'collection.withdraw',
    apply: async (user, payload, m) => {
      const p = parse(z.object({ collectionId: z.string().max(64).optional(), clientId: z.string().max(64).optional(), reason: z.string().trim().max(500).optional() }), payload);
      const id = p.collectionId ?? (await s.idByClientId(user, p.clientId ?? ''));
      const v = (await s.withdrawCollection(user, id, p.reason, m.meta)) as { id: string; status: string };
      return { entityId: v.id, status: v.status };
    },
  },
  {
    entity: 'collection_edit',
    permission: 'collection.edit',
    apply: async (user, payload, m) => {
      const p = parse(z.object({ collectionId: z.string().max(64).optional(), clientId: z.string().max(64).optional() }).passthrough(), payload);
      const id = p.collectionId ?? (await s.idByClientId(user, p.clientId ?? ''));
      const v = (await s.editCollection(user, id, parse(s.editSchema, payload), m.meta)) as { id: string; status: string };
      return { entityId: v.id, status: v.status };
    },
  },
];
