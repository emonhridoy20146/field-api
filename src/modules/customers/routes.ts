import { z } from 'zod';
import { defineRoutes, perm, requestMeta, requireUser } from '../../core/http/router.js';
import { AppError } from '../../core/errors/index.js';
import { parse } from '../../core/http/index.js';
import { parseLatLng } from '../../core/geo/index.js';
import * as s from './service.js';
import { PAY_STATES, type PayState } from './domain/status.js';
import { PAID_THIS_MONTH, type PaidThisMonth } from './domain/paid-month.js';

const FILTERS = ['overdue', 'due_today', 'promised_today', 'bad_suggested', 'tagged_bad', 'no_location', 'unassigned', 'paid_up'] as const;
/** `filter=overdue,due_today` (form style, explode=false); unknown values are a 400. */
const filterList = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []))
  .pipe(z.array(z.enum(FILTERS)));

/** 1.14.0 (FR-CUS-012): pin colours, `payState=missed_one,missed_many` (OR). */
const payStateList = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []))
  .pipe(z.array(z.enum(PAY_STATES as [PayState, ...PayState[]])));
/** 1.14.0 (FR-CUS-013): customers with an open invoice of this kind. */
const invoiceKind = z.enum(['installment', 'credit']).optional();
/** 1.29.0 (FR-CUS-019): paid something this Dhaka month (ERP or pending field money) or not. */
const paidThisMonth = z.enum(PAID_THIS_MONTH as [PaidThisMonth, ...PaidThisMonth[]]).optional();

const listQuery = z.object({
  filter: filterList,
  payState: payStateList,
  invoiceKind,
  paidThisMonth,
  assignedTo: z.string().max(64).optional(),
  branchId: z.string().max(64).optional(),
  areaId: z.string().max(64).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  near: z.string().optional(),
  radiusM: z.coerce.number().int().min(50).max(100_000).default(5000),
  sort: z.enum(['distance', '-daysOverdue', 'name', '-totalOutstanding', 'nextDueDate']).optional(),
  // 1.46.0: up to 1000 rows a page and an optional 0-based offset (wins over cursor) for the admin pager.
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  cursor: z.string().max(200).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  includeTotal: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

const mapQuery = z.object({
  bbox: z.string().max(100),
  zoom: z.coerce.number().int().min(1).max(22).optional(),
  filter: filterList,
  payState: payStateList,
  invoiceKind,
  paidThisMonth,
  branchId: z.string().max(64).optional(),
});

const pageQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), cursor: z.string().max(200).optional() });

const geoFix = z.object({ lat: z.number(), lng: z.number(), accuracyM: z.number().min(0), mock: z.boolean().optional(), capturedAt: z.string().optional(), provider: z.string().optional() });

export const proposalBody = z.object({
  clientId: z.string().uuid(),
  /** The proposed pin. With method `gps` it is the phone's fix; with `map` it is the point picked on the map. */
  geo: geoFix,
  /** 1.11.0: `gps` (default, the phone's position) or `map` (picked on a map, Uber style). */
  method: z.enum(['gps', 'map']).optional(),
  /** 1.11.0: where the phone was when a `map` pin was picked, so the manager can see how far away the staff was. */
  deviceGeo: geoFix.nullable().optional(),
  photoMediaId: z.string().max(64).optional(),
  note: z.string().max(500).optional(),
});

/** 1.11.0 (FR-CUS-011): a manager sets the pin directly. */
const setLocationBody = z.object({
  clientId: z.string().uuid(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  method: z.enum(['map', 'gps']).optional(),
  note: z.string().max(500).optional(),
});

/** 1.23.0 (FR-CUS-016): one to five numbers at once; each is checked and normalized by the service. */
export const addPhonesBody = z.object({
  phones: z
    .array(z.object({ number: z.string().trim().min(1).max(30), label: z.string().trim().max(30).nullable().optional() }))
    .min(1)
    .max(5),
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
    return { id: res.id, status: res.status, direct: res.direct };
  });
  r.post('/customers/:id/location', { access: perm('customer.location.approve') }, async (req, reply) => {
    const res = await s.setLocation(requireUser(req), idOf(req), parse(setLocationBody, req.body), requestMeta(req));
    reply.code(res.replayed ? 200 : 201);
    return { id: res.id, status: res.status, location: res.location };
  });
  // 1.17.0: delete the pin (ERP, field or map) so it is no longer shown; see clearLocation.
  r.delete('/customers/:id/location', { access: perm('customer.location.approve') }, async (req) => s.clearLocation(requireUser(req), idOf(req), requestMeta(req)));
  // 1.23.0 (FR-CUS-016): numbers added in FOS, never sent to the ERP.
  r.post('/customers/:id/phones', { access: perm('customer.phone.manage') }, async (req) =>
    s.addPhones(requireUser(req), idOf(req), parse(addPhonesBody, req.body).phones, requestMeta(req)),
  );
  r.delete('/customers/:id/phones/:number', { access: perm('customer.phone.manage') }, async (req) =>
    s.removePhone(requireUser(req), idOf(req), (req.params as { number: string }).number, requestMeta(req)),
  );
  // Plain array, as the contract has declared since 1.4.0.
  r.get('/location-proposals', { access: perm('customer.location.approve') }, async (req) => s.listProposals(requireUser(req), parse(proposalsQuery, req.query)));
  r.get('/location-proposals/mine', { access: perm('customer.location.propose') }, async (req) =>
    s.myProposals(requireUser(req), parse(z.object({ status: z.enum(['pending', 'approved', 'rejected']).optional() }), req.query).status),
  );
  r.post('/location-proposals/:id/decision', { access: perm('customer.location.approve') }, async (req) =>
    s.decideProposal(requireUser(req), idOf(req), parse(decisionBody, req.body), requestMeta(req)),
  );
});

