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
  // Effective values for one branch, so a super admin can see a branch-level OFF (contract 1.3.0).
  r.get('/feature-flags/effective', { access: perm('flag.manage') }, async (req) => {
    const q = parse(z.object({ branchId: z.string().max(64) }), req.query);
    return { branchId: q.branchId, flags: await s.effectiveForBranch(q.branchId) };
  });
  r.put('/feature-flags/:key', { access: perm('flag.manage') }, async (req) => {
    const { key } = req.params as { key: string };
    return s.setFlag(requireUser(req), key, parse(body, req.body), requestMeta(req));
  });
});
