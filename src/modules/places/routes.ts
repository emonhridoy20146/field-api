import { z } from 'zod';
import { defineRoutes, perm, requestMeta, requireUser } from '../../core/http/router.js';
import { parse, parseIfMatch } from '../../core/http/index.js';
import * as s from './service.js';

const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;

// Contract: docs/openapi.yaml `places` (1.38.0, FR-PLC-001..006).
export const placesRoutes = defineRoutes((r) => {
  r.get('/places', { access: perm('place.view') }, async (req) => s.list(requireUser(req), parse(s.listQuery, req.query)));
  r.post('/places', { access: perm('place.create') }, async (req, reply) => {
    const res = await s.create(requireUser(req), parse(s.createSchema, req.body), requestMeta(req));
    reply.code(res.statusCode);
    return res.body;
  });
  // Static path, registered before `/places/:id`; the static route wins either way.
  r.get('/places/move-requests', { access: perm('place.manage') }, async (req) => s.moveRequests(requireUser(req), parse(z.object({ branchId: z.string().max(64).optional() }), req.query).branchId));
  r.get('/places/:id', { access: perm('place.view') }, async (req) => s.get(requireUser(req), idOf(req)));
  // place.create: the service lets a staff member change only their own places' words; anything else needs place.manage.
  r.patch('/places/:id', { access: perm('place.create') }, async (req) =>
    s.edit(requireUser(req), idOf(req), parse(s.editSchema, req.body), parseIfMatch(req.headers['if-match'] as string | undefined), requestMeta(req)),
  );
  r.delete('/places/:id', { access: perm('place.manage') }, async (req) => s.remove(requireUser(req), idOf(req), parse(z.object({ reason: z.string().trim().max(200).optional() }), req.query).reason, requestMeta(req)));
  r.post('/places/:id/move-request', { access: perm('place.create') }, async (req, reply) => {
    const res = await s.requestMove(requireUser(req), idOf(req), parse(s.moveRequestSchema, req.body), requestMeta(req));
    reply.code(res.statusCode);
    return res.body;
  });
  r.post('/places/:id/move-request/decision', { access: perm('place.manage') }, async (req) => s.decideMove(requireUser(req), idOf(req), parse(s.decisionSchema, req.body), requestMeta(req)));
});
