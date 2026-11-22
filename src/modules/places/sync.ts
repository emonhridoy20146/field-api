import type { SyncMutationDef } from '../../core/module/types.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

/** Offline writes from the app (1.38.0). Each validates with the same zod schema as its REST route. */
export const syncMutations: SyncMutationDef[] = [
  {
    entity: 'place',
    permission: 'place.create',
    apply: async (user, payload, { meta }) => {
      const r = await s.create(user, parse(s.createSchema, payload), meta);
      return { entityId: r.body.id, replayed: r.statusCode === 200, extra: { version: r.body.version } };
    },
  },
  {
    // Same body and rules as PATCH /places/{id} (1.43.0, ADR-055): `location` is a direct move, applied only for
    // place.manage (else FORBIDDEN MOVE_NEEDS_MANAGE for the whole item). No If-Match offline: the last write wins.
    entity: 'place_edit',
    permission: 'place.create',
    apply: async (user, payload, { meta }) => {
      const ref = parse(s.placeRef, payload);
      const input = parse(s.syncEditSchema, stripRef(payload));
      const p = await s.edit(user, await s.resolveRef(user, ref), input, null, meta);
      return { entityId: p.id, extra: { version: p.version } };
    },
  },
  {
    entity: 'place_move_request',
    permission: 'place.create',
    apply: async (user, payload, { meta }) => {
      const ref = parse(s.placeRef, payload);
      const r = await s.requestMove(user, await s.resolveRef(user, ref), parse(s.moveRequestSchema, stripRef(payload)), meta);
      return { entityId: r.body.id, replayed: r.statusCode === 200, status: r.body.pendingMove ? 'pending' : 'decided' };
    },
  },
];

function stripRef(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const { placeId: _a, placeClientId: _b, ...rest } = payload as Record<string, unknown>;
  return rest;
}
