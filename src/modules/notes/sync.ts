import { z } from 'zod';
import type { SyncMutationDef } from '../../core/module/types.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

const withCustomer = z.object({ customerId: z.string().max(64) });

export const syncMutations: SyncMutationDef[] = [
  {
    entity: 'note',
    permission: 'note.create',
    apply: async (user, payload) => {
      const r = await s.createNote(user, parse(withCustomer, payload).customerId, parse(s.noteSchema, payload));
      return { entityId: r.body.id, replayed: r.statusCode === 200 };
    },
  },
  {
    entity: 'contact_attempt',
    permission: 'note.create',
    apply: async (user, payload) => {
      const r = await s.logContact(user, parse(withCustomer, payload).customerId, parse(s.contactSchema, payload));
      return { entityId: r.body.id, replayed: r.statusCode === 200 };
    },
  },
];
