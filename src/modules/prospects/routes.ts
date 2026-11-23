import { defineRoutes, perm, requestMeta, requireUser, type Access } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
/** Reads: prospect.view (branch scope) or prospect.create (own only); the service narrows by which one the caller has. */
const READ: Access = { anyOf: ['prospect.view', 'prospect.create'] };

// Contract: docs/openapi.yaml `prospects` (1.45.0, FR-PRO-001).
export const prospectRoutes = defineRoutes((r) => {
  r.get('/prospects', { access: READ }, async (req) => s.list(requireUser(req), parse(s.listQuery, req.query)));
  r.post('/prospects', { access: perm('prospect.create') }, async (req, reply) => {
    const res = await s.create(requireUser(req), parse(s.createSchema, req.body), requestMeta(req));
    reply.code(res.statusCode);
    return res.body;
  });
  r.get('/prospects/:id', { access: READ }, async (req) => s.get(requireUser(req), idOf(req)));
  r.patch('/prospects/:id', { access: perm('prospect.manage') }, async (req) => s.update(requireUser(req), idOf(req), parse(s.updateSchema, req.body), requestMeta(req)));
  r.post('/prospects/:id/convert', { access: perm('prospect.manage') }, async (req) => s.convert(requireUser(req), idOf(req), parse(s.convertSchema, req.body), requestMeta(req)));
  r.post('/prospects/:id/reopen', { access: perm('prospect.manage') }, async (req) => s.reopen(requireUser(req), idOf(req), parse(s.reopenSchema, req.body).reason, requestMeta(req)));
});
