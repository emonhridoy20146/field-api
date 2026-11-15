import { defineRoutes, perm, requireUser } from '../../core/http/router.js';
import { listBranches } from './service.js';

export const branchRoutes = defineRoutes((r) => {
  r.get('/branches', { access: perm('branch.view') }, async (req) => listBranches(requireUser(req)));
});
