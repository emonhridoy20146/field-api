import { z } from 'zod';
import { defineRoutes, perm, requestMeta, requireUser } from '../../core/http/router.js';
import { AppError } from '../../core/errors/index.js';
import { parse } from '../../core/http/index.js';
import { parseLatLng } from '../../core/geo/index.js';
import * as s from './service.js';

const FILTERS = ['overdue', 'due_today', 'promised_today', 'bad_suggested', 'tagged_bad', 'no_location', 'unassigned', 'paid_up'] as const;
/** `filter=overdue,due_today` (form style, explode=false); unknown values are a 400. */
const filterList = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []))
  .pipe(z.array(z.enum(FILTERS)));

const listQuery = z.object({
  filter: filterList,
  assignedTo: z.string().max(64).optional(),
  branchId: z.string().max(64).optional(),
  areaId: z.string().max(64).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  near: z.string().optional(),
  radiusM: z.coerce.number().int().min(50).max(100_000).default(5000),
  sort: z.enum(['distance', '-daysOverdue', 'name', '-totalOutstanding', 'nextDueDate']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
  includeTotal: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

const mapQuery = z.object({
  bbox: z.string().max(100),
  zoom: z.coerce.number().int().min(1).max(22).optional(),
  filter: filterList,
  branchId: z.string().max(64).optional(),
});

const pageQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), cursor: z.string().max(200).optional() });

export const proposalBody = z.object({
  clientId: z.string().uuid(),
  geo: z.object({ lat: z.number(), lng: z.number(), accuracyM: z.number().min(0), mock: z.boolean().optional(), capturedAt: z.string().optional(), provider: z.string().optional() }),
  photoMediaId: z.string().max(64).optional(),
  note: z.string().max(500).optional(),
});

const decisionBody = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().max(500).optional() });
const proposalsQuery = z.object({ branchId: z.string().max(64).optional(), status: z.enum(['pending', 'approved', 'rejected']).optional() });

const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
const VIEW = perm('customer.view');

export const customerRoutes = defineRoutes((r) => {
  r.get('/customers', { access: VIEW }, async (req) => {
    const q = parse(listQuery, req.query);
    const near = q.near ? parseLatLng(q.near) : null;
    if (q.near && !near) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'near', message: 'lat,lng' }] });
    return s.list(requireUser(req), { ...q, near });
  });
  r.get('/customers/map', { access: VIEW }, async (req) => s.map(requireUser(req), parse(mapQuery, req.query)));
  r.get('/customers/:id', { access: VIEW }, async (req) => s.detail(requireUser(req), idOf(req)));
  r.get('/customers/:id/timeline', { access: VIEW }, async (req) => {
    const q = parse(pageQuery, req.query);
    return s.timeline(requireUser(req), idOf(req), q.limit, q.cursor);
  });
  r.post('/customers/:id/refresh', { access: VIEW }, async (req) => s.refresh(requireUser(req), idOf(req)));
  r.post('/customers/:id/location-proposals', { access: perm('customer.location.propose') }, async (req, reply) => {
    const res = await s.proposeLocation(requireUser(req), idOf(req), parse(proposalBody, req.body), requestMeta(req));
    reply.code(res.replayed ? 200 : 201);
    return { id: res.id, status: res.status };
  });
  // Plain array, as the contract has declared since 1.4.0.
  r.get('/location-proposals', { access: perm('customer.location.approve') }, async (req) => s.listProposals(requireUser(req), parse(proposalsQuery, req.query)));
  r.get('/location-proposals/mine', { access: perm('customer.location.propose') }, async (req) =>
    s.myProposals(requireUser(req), parse(z.object({ status: z.enum(['pending', 'approved', 'rejected']).optional() }), req.query).status),
  );
  r.post('/location-proposals/:id/decision', { access: perm('customer.location.approve') }, async (req) =>
    s.decideProposal(requireUser(req), idOf(req), parse(decisionBody, req.body), requestMeta(req)),
  );
});

