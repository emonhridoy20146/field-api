import { z } from 'zod';
import { defineRoutes, perm, requireUser } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import * as service from './service.js';

const query = z.object({
  branchId: z.string().optional(),
  actorId: z.string().optional(),
  action: z.string().optional(),
  entity: z.string().optional(),
  entityId: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

export const auditRoutes = defineRoutes((r) => {
  r.get('/audit', { access: perm('audit.view') }, async (req) => service.list(requireUser(req), parse(query, req.query)));
});
