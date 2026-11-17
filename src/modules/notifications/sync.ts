import { z } from 'zod';
import type { SyncMutationDef } from '../../core/module/types.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

export const syncMutations: SyncMutationDef[] = [
  {
    // "I have read it" tapped offline (1.12.0). Self-service: only a recipient can acknowledge (service check).
    entity: 'broadcast_ack',
    apply: async (user, payload) => {
      const p = parse(z.object({ broadcastId: z.string().max(64), at: z.string().datetime({ offset: true }).optional() }), payload);
      await s.ack(user, p.broadcastId, p.at ? new Date(p.at) : undefined);
      return { entityId: p.broadcastId };
    },
  },
];
