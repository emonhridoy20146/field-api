import { z } from 'zod';
import { defineRoutes, perm, requestMeta, requireUser } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';
import * as t from './trends.js';
import * as x from './exports.js';

export const reportRoutes = defineRoutes((r) => {
  r.get('/dashboard/overview', { access: perm('report.view') }, async (req) => s.overview(requireUser(req), parse(z.object({ branchId: z.string().max(64).optional(), date: z.string().max(10).optional() }), req.query)));
  r.get('/reports/staff-performance', { access: perm('report.view') }, async (req) => t.staffPerformance(requireUser(req), parse(t.performanceQuery, req.query)));
  r.get('/reports/branch-trends', { access: perm('report.view') }, async (req) => t.branchTrends(requireUser(req), parse(t.trendsQuery, req.query)));
  r.get('/reports/reconciliation', { access: perm('report.view') }, async (req) => t.reconciliation(requireUser(req), parse(t.reconciliationQuery, req.query)));
  r.post('/reports/exports', { access: perm('report.export') }, async (req, reply) => {
    reply.code(202);
    return x.createExport(requireUser(req), parse(x.exportSchema, req.body), requestMeta(req));
  });
  r.get('/reports/exports/:id', { access: perm('report.export') }, async (req) => x.getExport(requireUser(req), (req.params as { id: string }).id));
});
