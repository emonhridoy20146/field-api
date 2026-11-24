import type { SyncMutationDef } from '../../core/module/types.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

/** Offline-first from the app (1.48.0): same bodies and rules as POST /requests and POST /requests/{id}/comment. */
export const syncMutations: SyncMutationDef[] = [
  {
    entity: 'request',
    permission: s.CREATE,
    apply: async (user, payload, { meta }) => {
      const r = await s.create(user, parse(s.createSchema, payload), meta);
      return { entityId: r.body.id, replayed: r.statusCode === 200, status: r.body.status, extra: { version: r.body.version } };
    },
  },
  {
    entity: 'request_comment',
    permission: s.CREATE,
    apply: async (user, payload, { meta }) => {
      const r = await s.commentFromSync(user, parse(s.syncCommentSchema, payload), meta);
      return { entityId: r.body.id, replayed: r.replayed, status: r.body.status, extra: { version: r.body.version } };
    },
  },
];
