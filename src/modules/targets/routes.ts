import { defineRoutes, perm, requestMeta, requireUser } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;

export const targetRoutes = defineRoutes((r) => {
  r.get('/targets', { access: perm('target.view') }, async (req) => s.list(requireUser(req), parse(s.listQuery, req.query)));
  r.get('/targets/me', { access: 'self' }, async (req) => s.mine(requireUser(req), parse(s.meQuery, req.query).date));
  r.put('/targets/users/:id', { access: perm('target.manage') }, async (req) => s.setUser(requireUser(req), idOf(req), parse(s.valueSchema, req.body), requestMeta(req)));
  r.post('/targets/users/:id/clear', { access: perm('target.manage') }, async (req) => s.clearUser(requireUser(req), idOf(req), parse(s.clearSchema, req.body), requestMeta(req)));
  r.get('/targets/users/:id/history', { access: perm('target.view') }, async (req) => s.history(requireUser(req), idOf(req)));
  r.put('/targets/branches/:id', { access: perm('target.manage') }, async (req) => s.setBranch(requireUser(req), idOf(req), parse(s.valueSchema, req.body), requestMeta(req)));
});
