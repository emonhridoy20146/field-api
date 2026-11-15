import { z } from 'zod';
import { defineRoutes, perm, requireUser } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

// Routes go into docs/openapi.yaml first (additive only), then here.
export const __camel__Routes = defineRoutes((r) => {
  r.get('/__name__', { access: perm('__name__.view') }, async (req) => s.list(requireUser(req), parse(z.object({ branchId: z.string().max(64).optional() }), req.query)));
});
