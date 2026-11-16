import { z } from 'zod';
import { defineRoutes, perm, requestMeta, requireUser } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

export const deviceRoutes = defineRoutes((r) => {
  r.get('/devices', { access: perm('device.manage') }, async (req) =>
    s.list(requireUser(req), parse(z.object({ branchId: z.string().optional(), userId: z.string().optional() }), req.query)),
  );
  r.post('/devices/:id/unbind', { access: perm('device.manage') }, async (req) => {
    const b = parse(z.object({ reason: z.string().min(5) }), req.body ?? {});
    return s.unbind(requireUser(req), (req.params as { id: string }).id, b.reason, requestMeta(req));
  });
  r.post('/devices/:id/approve', { access: perm('device.manage') }, async (req) => s.approve(requireUser(req), (req.params as { id: string }).id, requestMeta(req)));
});

