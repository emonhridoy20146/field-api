import { defineRoutes, perm, requestMeta, requireUser, type Access } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
/** Reads and comments: request.view (branch scope) or request.create (own and assigned); the service narrows. */
const READ: Access = { anyOf: [s.VIEW, s.CREATE] };
/** Moving a request: the area manager queue (request.manage) or the super admin queue (request.important.manage). */
const OFFICE: Access = { anyOf: [s.MANAGE, s.TOP] };
/** Resolve / reopen / close: the office, or the assignee / creator (request.create); the service decides (mayAct). */
const ACT: Access = { anyOf: [s.MANAGE, s.TOP, s.CREATE] };

// Contract: docs/openapi.yaml `requests` (1.48.0, FR-REQ-001..006, ADR-066).
export const requestRoutes = defineRoutes((r) => {
  r.get('/requests', { access: READ }, async (req) => s.list(requireUser(req), parse(s.listQuery, req.query)));
  r.post('/requests', { access: perm(s.CREATE) }, async (req, reply) => {
    const res = await s.create(requireUser(req), parse(s.createSchema, req.body), requestMeta(req));
    reply.code(res.statusCode);
    return res.body;
  });
  r.get('/requests/:id', { access: READ }, async (req) => s.get(requireUser(req), idOf(req)));
  r.post('/requests/:id/comment', { access: READ }, async (req) => (await s.comment(requireUser(req), idOf(req), parse(s.commentSchema, req.body), requestMeta(req))).body);
  r.post('/requests/:id/forward', { access: OFFICE }, async (req) => s.forward(requireUser(req), idOf(req), parse(s.forwardSchema, req.body), requestMeta(req)));
  r.post('/requests/:id/assign', { access: OFFICE }, async (req) => s.assign(requireUser(req), idOf(req), parse(s.assignSchema, req.body), requestMeta(req)));
  r.post('/requests/:id/resolve', { access: ACT }, async (req) => s.resolve(requireUser(req), idOf(req), parse(s.noteSchema, req.body).note, requestMeta(req)));
  r.post('/requests/:id/reopen', { access: ACT }, async (req) => s.reopen(requireUser(req), idOf(req), parse(s.noteSchema, req.body).note, requestMeta(req)));
  r.post('/requests/:id/close', { access: ACT }, async (req) => s.close(requireUser(req), idOf(req), parse(s.closeSchema, req.body ?? {}).note || null, requestMeta(req)));
});
