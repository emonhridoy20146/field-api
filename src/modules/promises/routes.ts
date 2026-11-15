import { z } from 'zod';
import { defineRoutes, perm, requireUser } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const promiseRoutes = defineRoutes((r) => {
  r.get('/promises', { access: perm('promise.view') }, async (req) =>
    s.list(
      requireUser(req),
      parse(z.object({ branchId: z.string().max(64).optional(), ownerId: z.string().max(64).optional(), customerId: z.string().max(64).optional(), date: day.optional(), from: day.optional(), to: day.optional(), status: z.enum(['open', 'kept', 'partially_kept', 'broken', 'superseded', 'cancelled']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(200).optional() }), req.query),
    ),
  );
  r.post('/promises', { access: perm('promise.create') }, async (req, reply) => {
    const res = await s.create(requireUser(req), parse(s.createSchema, req.body));
    reply.code(res.statusCode);
    return res.body;
  });
  r.post('/promises/:id/cancel', { access: perm('promise.create') }, async (req) => s.cancel(requireUser(req), (req.params as { id: string }).id, parse(z.object({ reason: z.string().trim().min(5).max(500) }), req.body).reason));
});
