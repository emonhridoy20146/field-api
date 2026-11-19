import type { SyncMutationDef } from '../../core/module/types.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

export const syncMutations: SyncMutationDef[] = [
  {
    entity: 'attendance_event',
    permission: 'attendance.record',
    apply: async (user, payload) => {
      const r = await s.recordEvent(user, parse(s.eventSchema, payload));
      return { entityId: `${r.body.userId}:${r.body.businessDate}`, replayed: r.statusCode === 200, status: r.body.status };
    },
  },
  {
    // contract 1.21.0: the photo of an event that was sent without waiting for it
    entity: 'attendance_selfie',
    permission: 'attendance.record',
    apply: async (user, payload) => {
      const day = await s.attachSelfie(user, parse(s.attachSelfieSchema, payload));
      return { entityId: `${day.userId}:${day.businessDate}`, status: day.status };
    },
  },
];
