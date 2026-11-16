import { z } from 'zod';
import type { SyncMutationDef } from '../../core/module/types.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

export const syncMutations: SyncMutationDef[] = [
  {
    entity: 'handover_decision',
    // Self-service like the REST accept/reject routes: only the receiver can decide (service check).
    apply: async (user, payload, m) => {
      const p = parse(z.object({ handoverId: z.string().max(64), decision: z.enum(['accept', 'reject']), reason: z.string().trim().min(5).max(500).optional() }).refine((x) => x.decision === 'accept' || !!x.reason, { message: 'reason required to reject', path: ['reason'] }), payload);
      const h = p.decision === 'accept' ? await s.accept(user, p.handoverId, m.meta) : await s.reject(user, p.handoverId, p.reason!, m.meta);
      return { entityId: p.handoverId, status: (h as { status: string }).status };
    },
  },
];
