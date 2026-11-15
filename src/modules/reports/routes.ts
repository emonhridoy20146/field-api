import { z } from 'zod';
import { defineRoutes, perm, requireUser } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

export const reportRoutes = defineRoutes((r) => {
  r.get('/dashboard/overview', { access: perm('report.view') }, async (req) => s.overview(requireUser(req), parse(z.object({ branchId: z.string().max(64).optional(), date: z.string().max(10).optional() }), req.query)));
});
