import { z } from 'zod';
import { defineRoutes, perm, requestMeta, requireUser } from '../../core/http/router.js';
import { parse, parseIfMatch } from '../../core/http/index.js';
import * as s from './service.js';

const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
const listQuery = z.object({
  branchId: z.string().max(64).optional(),
  userId: z.string().max(64).optional(),
  customerId: z.string().max(64).optional(),
  active: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
});
const createBody = z.object({
  userId: z.string().max(64),
  type: z.enum(['area', 'customer']),
  areaId: z.string().max(64).optional(),
  customerId: z.string().max(64).optional(),
  reason: z.string().max(500).optional(),
});
const bulkBody = z.object({ userId: z.string().max(64), customerIds: z.array(z.string().max(64)).min(1).max(1000), reason: z.string().max(500).optional() });

export const assignmentRoutes = defineRoutes((r) => {
  r.get('/areas', { access: perm('assignment.view') }, async (req) => s.listAreas(requireUser(req), parse(z.object({ branchId: z.string().max(64).optional() }), req.query).branchId));
  r.post('/areas', { access: perm('assignment.manage') }, async (req, reply) => {
    reply.code(201);
    return s.createArea(requireUser(req), parse(s.areaSchema, req.body), requestMeta(req));
  });
  r.patch('/areas/:id', { access: perm('assignment.manage') }, async (req) =>
    s.updateArea(requireUser(req), idOf(req), parse(s.areaPatchSchema, req.body), parseIfMatch(req.headers['if-match'] as string | undefined), requestMeta(req)),
  );
  r.get('/assignments', { access: perm('assignment.view') }, async (req) => s.listAssignments(requireUser(req), parse(listQuery, req.query)));
  r.post('/assignments', { access: perm('assignment.manage') }, async (req, reply) => {
    reply.code(201);
    return s.createAssignment(requireUser(req), parse(createBody, req.body), requestMeta(req));
  });
  r.post('/assignments/bulk', { access: perm('assignment.manage') }, async (req) => s.bulkAssign(requireUser(req), parse(bulkBody, req.body), requestMeta(req)));
  r.delete('/assignments/:id', { access: perm('assignment.manage') }, async (req) => {
    await s.endAssignment(requireUser(req), idOf(req), requestMeta(req));
  });
});
