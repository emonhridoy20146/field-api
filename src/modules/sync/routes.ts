import { z } from 'zod';
import { defineRoutes, perm, requestMeta, requireUser } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

/** Sync routes are self-service: every item is permission- and scope-checked by its owning module. */
export const syncRoutes = defineRoutes((r) => {
  r.get('/sync/pull', { access: 'self' }, async (req) => s.pull(requireUser(req), parse(z.object({ cursor: z.string().max(40), limit: z.coerce.number().int().min(1).max(500).default(500) }), req.query)));
  r.get('/sync/bootstrap', { access: 'self' }, async (req) => s.bootstrap(requireUser(req), parse(z.object({ cursor: z.string().max(400).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }), req.query)));
  r.post('/sync/push', { access: 'self' }, async (req) => s.push(requireUser(req), parse(s.pushSchema, req.body), requestMeta(req)));
  r.get('/system/sync-health', { access: perm('settings.manage') }, async (req) => s.health(requireUser(req), parse(z.object({ branchId: z.string().max(64).optional() }), req.query).branchId));
});
