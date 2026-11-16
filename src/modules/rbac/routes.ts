import { z } from 'zod';
import { defineRoutes, perm, requestMeta, requireUser } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import { ROLES, type Role } from '../../core/security/types.js';
import * as s from './service.js';

const change = z.object({ key: z.string(), effect: z.enum(['allow', 'deny', 'inherit']) });

export const rbacRoutes = defineRoutes((r) => {
  r.get('/rbac/permissions', { access: perm('rbac.view') }, async () =>
    s.catalog().map((p) => ({ key: p.key, module: p.module, description: p.description, defaults: p.defaults, reserved: !!p.reserved })),
  );
  r.get('/rbac/users/:userId/effective', { access: perm('rbac.view') }, async (req) => s.explain(requireUser(req), (req.params as { userId: string }).userId));
  r.get('/rbac/overrides/branch/:branchId', { access: perm('rbac.view') }, async (req) => s.listBranchOverrides(requireUser(req), (req.params as { branchId: string }).branchId));
  r.get('/rbac/overrides/user/:userId', { access: perm('rbac.view') }, async (req) => s.listUserOverrides(requireUser(req), (req.params as { userId: string }).userId));
  r.put('/rbac/overrides/branch/:branchId', { access: perm('rbac.manage') }, async (req) => {
    const b = parse(z.object({ role: z.enum(ROLES as [Role, ...Role[]]), changes: z.array(change).min(1), reason: z.string().min(5) }), req.body);
    return s.setBranchOverrides(requireUser(req), (req.params as { branchId: string }).branchId, b.role, b.changes, b.reason, requestMeta(req));
  });
  r.put('/rbac/overrides/user/:userId', { access: perm('rbac.manage') }, async (req) => {
    const b = parse(z.object({ changes: z.array(change).min(1), reason: z.string().min(5) }), req.body);
    return s.setUserOverrides(requireUser(req), (req.params as { userId: string }).userId, b.changes, b.reason, requestMeta(req));
  });
});
