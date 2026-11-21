import { defineRoutes, perm, requireUser } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

export const activityRoutes = defineRoutes((r) => {
  r.get('/activity', { access: perm('activity.view') }, async (req) => s.list(requireUser(req), parse(s.listQuery, req.query)));
  r.post('/activity/seen', { access: perm('activity.view') }, async (req) => s.markSeen(requireUser(req)));
});
