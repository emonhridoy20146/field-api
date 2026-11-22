import { z } from 'zod';
import { defineRoutes, hasPermission, perm, requestMeta, requireUser } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const branchId = z.string().max(64).optional();

export const attendanceRoutes = defineRoutes((r) => {
  r.post('/attendance/events', { access: perm('attendance.record') }, async (req, reply) => {
    const res = await s.recordEvent(requireUser(req), parse(s.eventSchema, req.body));
    reply.code(res.statusCode);
    return res.body;
  });
  r.get('/attendance/events', { access: perm('attendance.view') }, async (req) => s.eventsOfDay(requireUser(req), parse(z.object({ userId: z.string().max(64), date }), req.query)));
  r.post('/attendance/photos/delete', { access: perm('media.delete') }, async (req) => s.deletePhotosOfDay(requireUser(req), parse(s.deletePhotosSchema, req.body), requestMeta(req)));
  r.get('/attendance/me/today', { access: perm('attendance.record') }, async (req) => s.myToday(requireUser(req)));
  r.get('/attendance/me/shift', { access: perm('attendance.record') }, async (req) => s.myShift(requireUser(req)));
  r.get('/attendance/days', { access: perm('attendance.view') }, async (req) =>
    s.days(requireUser(req), parse(z.object({ branchId, userId: z.string().max(64).optional(), from: date, to: date }), req.query)),
  );
  r.get('/attendance/summary', { access: perm('attendance.view') }, async (req) => s.summary(requireUser(req), parse(z.object({ branchId, month: z.string().max(7) }), req.query)));
  r.post('/attendance/corrections', { access: perm('attendance.manage') }, async (req, reply) => {
    reply.code(201);
    return s.correct(requireUser(req), parse(s.correctionSchema, req.body), requestMeta(req));
  });

  // Staff see their own requests; holders of attendance.manage see their branches (service scope).
  r.get('/leave-requests', { access: { anyOf: ['leave.request', 'attendance.manage'] } }, async (req) =>
    s.listLeave(requireUser(req), await hasPermission(req, 'attendance.manage'), parse(s.leaveListSchema, req.query)),
  );
  r.post('/leave-requests', { access: perm('leave.request') }, async (req, reply) => {
    reply.code(201);
    return s.requestLeave(requireUser(req), parse(s.leaveSchema, req.body));
  });
  r.post('/leave-requests/:id/cancel', { access: perm('leave.request') }, async (req) => s.cancelLeave(requireUser(req), (req.params as { id: string }).id));
  r.post('/leave-requests/:id/decision', { access: perm('attendance.manage') }, async (req) =>
    s.decideLeave(requireUser(req), (req.params as { id: string }).id, parse(z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(500).optional() }), req.body), requestMeta(req)),
  );
});
