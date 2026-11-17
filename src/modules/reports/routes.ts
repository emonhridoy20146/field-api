import { z } from 'zod';
import { defineRoutes, perm, requestMeta, requireUser } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';
import * as t from './trends.js';
import * as x from './exports.js';
import * as i from './insights.js';

export const reportRoutes = defineRoutes((r) => {
  r.get('/dashboard/overview', { access: perm('report.view') }, async (req) => s.overview(requireUser(req), parse(z.object({ branchId: z.string().max(64).optional(), date: z.string().max(10).optional() }), req.query)));
  r.get('/reports/staff-performance', { access: perm('report.view') }, async (req) => t.staffPerformance(requireUser(req), parse(t.performanceQuery, req.query)));
  r.get('/reports/branch-trends', { access: perm('report.view') }, async (req) => t.branchTrends(requireUser(req), parse(t.trendsQuery, req.query)));
  r.get('/reports/reconciliation', { access: perm('report.view') }, async (req) => t.reconciliation(requireUser(req), parse(t.reconciliationQuery, req.query)));
  r.get('/reports/me/performance', { access: 'self' }, async (req) => i.myPerformance(requireUser(req), parse(i.mineQuery, req.query)));
  // Managers need report.view; field staff are let in only when the leaderboard is switched on for them (checked inside).
  r.get('/reports/leaderboard', { access: 'self' }, async (req) => i.leaderboard(requireUser(req), parse(i.leaderboardQuery, req.query)));
  r.get('/reports/data-quality', { access: perm('report.view') }, async (req) => i.dataQuality(requireUser(req), parse(i.qualityQuery, req.query)));
  r.get('/reports/data-quality/items', { access: perm('report.view') }, async (req) => i.dataQualityItems(requireUser(req), parse(i.qualityItemsQuery, req.query)));
  r.post('/reports/exports', { access: perm('report.export') }, async (req, reply) => {
    reply.code(202);
    return x.createExport(requireUser(req), parse(x.exportSchema, req.body), requestMeta(req));
  });
  r.get('/reports/exports/:id', { access: perm('report.export') }, async (req) => x.getExport(requireUser(req), (req.params as { id: string }).id));
});
