import { z } from 'zod';
import type { SyncMutationDef } from '../../core/module/types.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

export const syncMutations: SyncMutationDef[] = [
  {
    // "I finished it" tapped offline (1.16.0). Only the assignee can do it: the service looks the task up by assignee.
    entity: 'task_resolve_request',
    permission: 'task.work',
    apply: async (user, payload, { meta }) => {
      const p = parse(z.object({ taskId: z.string().max(64) }).merge(s.resolveRequestSchema), payload);
      const t = await s.requestResolve(user, p.taskId, { ...(p.note ? { note: p.note } : {}), ...(p.requestedAt ? { requestedAt: p.requestedAt } : {}) }, meta);
      return { entityId: t.id, status: t.status };
    },
  },
];
