import { z } from 'zod';
import { defineRoutes, hasPermission, perm, requestMeta, requireUser } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

export const settingsRoutes = defineRoutes((r) => {
  // Read: any user gets the app-exposed subset; settings.manage gets everything.
  r.get('/settings', { access: 'self' }, async (req) => {
    const user = requireUser(req);
    const q = parse(z.object({ branchId: z.string().optional() }), req.query);
    return s.view(user, await hasPermission(req, 'settings.manage'), q.branchId);
  });
  r.patch('/settings', { access: perm('settings.manage') }, async (req) => {
    const body = parse(z.object({ branchId: z.string().optional(), changes: z.record(z.unknown()), reason: z.string().min(5) }), req.body);
    return { updated: await s.update(requireUser(req), body, requestMeta(req)) };
  });
  r.get('/calendar/holidays', { access: 'self' }, async (req) => {
    const q = parse(z.object({ year: z.coerce.number().int().optional() }), req.query);
    return s.listHolidays(q.year);
  });
  r.post('/calendar/holidays', { access: perm('settings.manage') }, async (req, reply) => {
    reply.code(201);
    return s.createHoliday(requireUser(req), parse(s.holidaySchema, req.body), requestMeta(req));
  });
  r.get('/shifts', { access: 'self' }, async () => s.listShifts());
  r.post('/shifts', { access: perm('settings.manage') }, async (req, reply) => {
    reply.code(201);
    return s.createShift(requireUser(req), parse(s.shiftSchema, req.body), requestMeta(req));
  });
  r.patch('/shifts/:id', { access: perm('settings.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    return s.updateShift(requireUser(req), id, parse(s.shiftSchema.partial(), req.body), requestMeta(req));
  });
});
