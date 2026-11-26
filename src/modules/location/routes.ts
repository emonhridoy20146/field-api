import { z } from 'zod';
import { defineRoutes, perm, requestMeta, requireUser } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

const who = { userId: z.string().max(64), date: z.string().max(10) };

export const locationRoutes = defineRoutes((r) => {
  // Only people who record attendance (field staff) send points; the global rate limit stays in force (CLAUDE.md §3).
  // 1.49.0 (ADR-067): also accepts `Authorization: Tracking <token>` from the native service; no other route does.
  r.post('/location/points', { access: perm('attendance.record'), bodyLimit: 512 * 1024, trackingAuth: s.trackingUser }, async (req, reply) => {
    reply.code(200);
    return s.ingest(requireUser(req), parse(s.ingestSchema, req.body));
  });
  r.post('/location/tracking-token', { access: perm('attendance.record') }, async (req, reply) => {
    reply.code(200);
    return s.issueTrackingToken(requireUser(req), requestMeta(req));
  });
  r.post('/location/heartbeat', { access: perm('attendance.record') }, async (req, reply) => {
    await s.heartbeat(requireUser(req), parse(s.heartbeatSchema, req.body ?? {}));
    reply.code(204);
  });
  r.get('/location/latest', { access: perm('location.view') }, async (req) => s.latest(requireUser(req), parse(z.object({ branchId: z.string().max(64).optional() }), req.query).branchId));
  r.get('/location/history', { access: perm('location.history.view') }, async (req) => s.history(requireUser(req), parse(z.object({ ...who, simplify: z.coerce.number().min(0).max(500).default(10) }), req.query)));
  r.get('/location/stops', { access: perm('location.history.view') }, async (req) => s.stops(requireUser(req), parse(z.object(who), req.query)));
});
