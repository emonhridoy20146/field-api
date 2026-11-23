import { z } from 'zod';
import { defineRoutes, perm, requestMeta, requireUser } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;

export const inboxRoutes = defineRoutes((r) => {
  r.get('/inbox', { access: perm('inbox.view') }, async (req) =>
    s.list(requireUser(req), parse(s.listQuery, req.query)),
  );
  r.post('/inbox/:id/resolve', { access: perm('inbox.view') }, async (req) => s.resolve(requireUser(req), idOf(req), parse(z.object({ reason: z.string().trim().max(500).optional() }), req.body ?? {}).reason ?? null, requestMeta(req)));
  r.post('/inbox/:id/snooze', { access: perm('inbox.view') }, async (req) => s.snooze(requireUser(req), idOf(req), new Date(parse(z.object({ until: z.string().datetime({ offset: true }) }), req.body).until)));
});
