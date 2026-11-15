import { z } from 'zod';
import { defineRoutes, perm, requestMeta, requireUser } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

const body = z.object({
  defaultEnabled: z.boolean().optional(),
  branchOverrides: z.array(z.object({ branchId: z.string(), enabled: z.boolean() })).optional(),
  reason: z.string().min(5),
});

export const flagRoutes = defineRoutes((r) => {
  r.get('/feature-flags', { access: perm('flag.manage') }, async () => s.list());
  r.put('/feature-flags/:key', { access: perm('flag.manage') }, async (req) => {
    const { key } = req.params as { key: string };
    return s.setFlag(requireUser(req), key, parse(body, req.body), requestMeta(req));
  });
});
