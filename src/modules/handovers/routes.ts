import { z } from 'zod';
import { defineRoutes, perm, requestMeta, requireUser } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
const listQuery = z.object({
  branchId: z.string().max(64).optional(),
  status: z.enum(['pending_acceptance', 'accepted', 'rejected', 'cancelled', 'expired', 'reverted']).optional(),
  mine: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

export const handoverRoutes = defineRoutes((r) => {
  // Receivers (field staff) list/get/accept/reject their own; managers see their branches (service scope).
  r.get('/handovers', { access: 'self' }, async (req) => s.list(requireUser(req), parse(listQuery, req.query)));
  r.post('/handovers', { access: perm('handover.create') }, async (req, reply) => {
    reply.code(201);
    return s.create(requireUser(req), parse(s.createSchema, req.body), requestMeta(req));
  });
  r.get('/handovers/:id', { access: 'self' }, async (req) => s.get(requireUser(req), idOf(req)));
  r.post('/handovers/:id/accept', { access: 'self' }, async (req) => s.accept(requireUser(req), idOf(req), requestMeta(req)));
  r.post('/handovers/:id/reject', { access: 'self' }, async (req) => {
    const b = parse(z.object({ reason: z.string().trim().min(5).max(500) }), req.body);
    return s.reject(requireUser(req), idOf(req), b.reason, requestMeta(req));
  });
  r.post('/handovers/:id/cancel', { access: perm('handover.create') }, async (req) => s.cancel(requireUser(req), idOf(req), requestMeta(req)));
});
