import { defineRoutes, perm, requireUser } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;

export const coworkRoutes = defineRoutes((r) => {
  r.post('/cowork/requests', { access: perm('cowork.use') }, async (req, reply) => {
    const res = await s.request(requireUser(req), parse(s.requestSchema, req.body));
    reply.code(res.statusCode);
    return res.body;
  });
  r.get('/cowork/colleagues', { access: perm('cowork.use') }, async (req) => s.colleagues(requireUser(req)));
  r.get('/cowork/sessions/mine', { access: perm('cowork.use') }, async (req) => s.mine(requireUser(req)));
  r.post('/cowork/sessions/:id/respond', { access: perm('cowork.use') }, async (req) => s.respond(requireUser(req), idOf(req), parse(s.respondSchema, req.body)));
  r.post('/cowork/sessions/:id/leave', { access: perm('cowork.use') }, async (req) => s.leave(requireUser(req), idOf(req)));
  r.get('/cowork/sessions', { access: perm('cowork.view') }, async (req) => s.list(requireUser(req), parse(s.listQuery, req.query)));
  r.post('/cowork/sessions/:id/end', { access: perm('cowork.manage') }, async (req) => s.endByOffice(requireUser(req), idOf(req), parse(s.endSchema, req.body)));
  r.get('/cowork/sessions/:id', { access: perm('cowork.view') }, async (req) => s.get(requireUser(req), idOf(req)));
});
