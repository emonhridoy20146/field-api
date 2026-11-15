import { z } from 'zod';
import { defineRoutes, perm, requireUser } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
export const visitRoutes = defineRoutes((r) => {
  r.get('/visits', { access: perm('visit.view') }, async (req) =>
    s.list(requireUser(req), parse(z.object({ branchId: z.string().max(64).optional(), userId: z.string().max(64).optional(), customerId: z.string().max(64).optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(200).optional() }), req.query)),
  );
  r.post('/visits', { access: perm('visit.record') }, async (req, reply) => {
    const res = await s.create(requireUser(req), parse(s.createSchema, req.body));
    reply.code(res.statusCode);
    return res.body;
  });
  r.patch('/visits/:id/checkout', { access: perm('visit.record') }, async (req) =>
    s.checkout(requireUser(req), idOf(req), parse(z.object({ checkOutAt: z.string().datetime({ offset: true }), outcome: z.enum(s.OUTCOMES).optional() }), req.body)),
  );
});
