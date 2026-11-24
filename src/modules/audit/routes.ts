import { z } from 'zod';
import { defineRoutes, perm, requireUser } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import { endOfBusinessDay, isIsoDate, startOfBusinessDay } from '../../core/time/index.js';
import * as service from './service.js';

/**
 * `from` / `to`: an exact instant (date-time, as before), or since 1.48.0 an inclusive Asia/Dhaka business date
 * (FR-AUD-003): `from` = 00:00 Dhaka of that date, `to` = the last millisecond of that Dhaka day.
 */
const bound = (edge: 'start' | 'end') =>
  z
    .union([z.string().datetime({ offset: true }), z.string().refine(isIsoDate, 'YYYY-MM-DD or an ISO date-time')])
    .transform((v) => (isIsoDate(v) ? (edge === 'start' ? startOfBusinessDay(v) : endOfBusinessDay(v)).toISOString() : new Date(v).toISOString()));

const query = z
  .object({
    branchId: z.string().optional(),
    actorId: z.string().optional(),
    action: z.string().optional(),
    entity: z.string().optional(),
    entityId: z.string().optional(),
    from: bound('start').optional(),
    to: bound('end').optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: '`from` is after `to`', path: ['from'] });

export const auditRoutes = defineRoutes((r) => {
  r.get('/audit', { access: perm('audit.view') }, async (req) => service.list(requireUser(req), parse(query, req.query)));
});
