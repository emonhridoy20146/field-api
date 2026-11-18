import { defineRoutes, perm, requestMeta, requireUser } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;

export const taskRoutes = defineRoutes((r) => {
  // Staff side. `/tasks/mine` is registered before `/tasks/:id` on purpose; the static path wins either way.
  r.get('/tasks/mine', { access: perm('task.work') }, async (req) => s.mine(requireUser(req)));
  r.post('/tasks/:id/resolve-request', { access: perm('task.work') }, async (req) => s.requestResolve(requireUser(req), idOf(req), parse(s.resolveRequestSchema, req.body ?? {}), requestMeta(req)));

  // Admin side.
  r.get('/tasks', { access: perm('task.view') }, async (req) => s.list(requireUser(req), parse(s.listQuery, req.query)));
  r.post('/tasks', { access: perm('task.manage') }, async (req, reply) => {
    const res = await s.create(requireUser(req), parse(s.createSchema, req.body), requestMeta(req));
    reply.code(res.statusCode);
    return res.body;
  });
  r.get('/tasks/:id', { access: perm('task.view') }, async (req) => s.get(requireUser(req), idOf(req)));
  r.patch('/tasks/:id', { access: perm('task.manage') }, async (req) => s.edit(requireUser(req), idOf(req), parse(s.editSchema, req.body), requestMeta(req)));
  r.post('/tasks/:id/verify', { access: perm('task.manage') }, async (req) => s.verify(requireUser(req), idOf(req), parse(s.noteSchema, req.body ?? {}).note, requestMeta(req)));
  r.post('/tasks/:id/reject', { access: perm('task.manage') }, async (req) => s.reject(requireUser(req), idOf(req), parse(s.rejectSchema, req.body ?? {}).reason, requestMeta(req)));
  r.post('/tasks/:id/cancel', { access: perm('task.manage') }, async (req) => s.cancel(requireUser(req), idOf(req), parse(s.noteSchema, req.body ?? {}).note, requestMeta(req)));
});
