import { z } from 'zod';
import { defineRoutes, perm, requestMeta, requireUser } from '../../core/http/router.js';
import { parse, parseIfMatch, etag } from '../../core/http/index.js';
import { ROLES, type Role } from '../../core/security/types.js';
import * as s from './service.js';

const listQuery = z.object({
  branchId: z.string().optional(),
  role: z.enum(ROLES as [Role, ...Role[]]).optional(),
  active: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});
const idParam = (req: { params: unknown }) => (req.params as { id: string }).id;

export const userRoutes = defineRoutes((r) => {
  r.get('/users', { access: perm('user.view') }, async (req) => s.list(requireUser(req), parse(listQuery, req.query)));
  r.post('/users', { access: perm('user.manage') }, async (req, reply) => {
    reply.code(201);
    return s.create(requireUser(req), parse(s.createSchema, req.body), requestMeta(req));
  });
  r.get('/users/:id', { access: perm('user.view') }, async (req, reply) => {
    const u = await s.getUserInScope(requireUser(req), idParam(req));
    reply.header('ETag', etag(u.version));
    return u;
  });
  r.patch('/users/:id', { access: perm('user.manage') }, async (req, reply) => {
    const u = await s.update(requireUser(req), idParam(req), parse(s.updateSchema, req.body), parseIfMatch(req.headers['if-match'] as string | undefined), requestMeta(req));
    reply.header('ETag', etag(u.version));
    return u;
  });
  r.post('/users/:id/reset-password', { access: perm('user.manage') }, async (req) => s.resetPassword(requireUser(req), idParam(req), requestMeta(req)));
  r.post('/users/:id/deactivate', { access: perm('user.manage') }, async (req) => {
    const body = parse(z.object({ reason: z.string().min(5) }), req.body ?? {});
    return s.setActive(requireUser(req), idParam(req), false, body.reason, requestMeta(req));
  });
  r.post('/users/:id/activate', { access: perm('user.manage') }, async (req) => s.setActive(requireUser(req), idParam(req), true, null, requestMeta(req)));
});
