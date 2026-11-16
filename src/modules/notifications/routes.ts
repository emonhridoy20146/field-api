import { z } from 'zod';
import { defineRoutes, hasPermission, perm, requestMeta, requireUser } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import { registerPushToken } from '../devices/index.js';
import * as s from './service.js';

const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
const page = { limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().max(200).optional() };

export const notificationRoutes = defineRoutes((r) => {
  // Own notifications are self-service (02-requirements §3.1).
  r.get('/notifications', { access: 'self' }, async (req) => s.list(requireUser(req), parse(z.object({ ...page, unread: z.enum(['true', 'false']).transform((v) => v === 'true').optional() }), req.query)));
  r.post('/notifications/read-all', { access: 'self' }, async (req, reply) => {
    await s.markAllRead(requireUser(req));
    reply.code(204);
  });
  r.post('/notifications/:id/read', { access: 'self' }, async (req, reply) => {
    await s.markRead(requireUser(req), idOf(req));
    reply.code(204);
  });
  r.post('/devices/push-token', { access: 'self' }, async (req, reply) => {
    const b = parse(z.object({ deviceId: z.string().min(1).max(100), fcmToken: z.string().min(20).max(4096) }), req.body);
    const user = requireUser(req);
    // The token is bound to the device of this session, never to one named by the client.
    await registerPushToken(user, user.deviceId ?? b.deviceId, b.fcmToken);
    reply.code(204);
  });

  r.get('/broadcasts', { access: 'self' }, async (req) => s.listBroadcasts(requireUser(req), await hasPermission(req, 'notification.broadcast'), parse(z.object(page), req.query)));
  r.post('/broadcasts', { access: perm('notification.broadcast') }, async (req, reply) => {
    reply.code(201);
    return s.createBroadcast(requireUser(req), parse(s.broadcastSchema, req.body), requestMeta(req));
  });
  r.post('/broadcasts/:id/ack', { access: 'self' }, async (req, reply) => {
    await s.ack(requireUser(req), idOf(req));
    reply.code(204);
  });
});
