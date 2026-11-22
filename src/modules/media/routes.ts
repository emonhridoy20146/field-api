import { z } from 'zod';
import { defineRoutes, perm, requestMeta, requireUser } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import { requestOrigin } from '../../core/http/origin.js';
import * as s from './service.js';
import * as cloud from './cloud.js';

const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;

// Media is self-service: callers only touch their own uploads; reads are branch-scoped in the service.
export const mediaRoutes = defineRoutes((r) => {
  // FR-MED-003: delete the photos of previous months (admin panel). Branch-scoped in the service.
  r.get('/media/purge/preview', { access: perm('media.delete') }, async (req) => cloud.purgePreview(requireUser(req), parse(cloud.previewSchema, req.query)));
  r.post('/media/purge', { access: perm('media.delete') }, async (req) => cloud.purge(requireUser(req), parse(cloud.purgeSchema, req.body), requestMeta(req)));
  r.post('/media/upload-url', { access: 'self' }, async (req, reply) => {
    reply.code(201);
    return s.uploadUrl(requireUser(req), parse(s.uploadSchema, req.body), requestOrigin(req));
  });
  r.post('/media/:id/confirm', { access: 'self' }, async (req) => s.confirm(requireUser(req), idOf(req)));
  r.get('/media/:id/url', { access: 'self' }, async (req) => {
    parse(z.object({ variant: z.enum(['original', 'thumb']).optional() }), req.query);
    return s.signedUrl(requireUser(req), idOf(req), requestOrigin(req));
  });
});
