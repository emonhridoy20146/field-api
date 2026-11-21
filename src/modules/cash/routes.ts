import { z } from 'zod';
import { defineRoutes, perm, requestMeta, requireUser } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import { AppError } from '../../core/errors/index.js';
import * as s from './service.js';

const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
const keyOf = (h: Record<string, unknown>) => {
  const k = h['idempotency-key'];
  if (typeof k !== 'string' || !z.string().uuid().safeParse(k).success) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'Idempotency-Key', message: 'UUID header required' }] });
  return k;
};

export const cashRoutes = defineRoutes((r) => {
  r.get('/cash/me', { access: perm('cash.view') }, async (req) => s.positionOf(requireUser(req).id));
  r.get('/cash/me/collections', { access: perm('cash.view') }, async (req) => s.inHandOf(requireUser(req), requireUser(req).id));
  r.get('/cash/positions/:id/collections', { access: perm('cash.view') }, async (req) => s.inHandOf(requireUser(req), idOf(req)));
  r.get('/cash/deposits/:id/collections', { access: perm('cash.view') }, async (req) => s.depositCollections(requireUser(req), idOf(req)));
  r.get('/cash/positions', { access: perm('cash.view') }, async (req) => s.branchPositions(requireUser(req), parse(z.object({ branchId: z.string().max(64).optional() }), req.query).branchId));
  r.get('/cash/deposits', { access: perm('cash.view') }, async (req) =>
    s.listDeposits(requireUser(req), parse(z.object({ branchId: z.string().max(64).optional(), status: z.enum(['pending', 'verified', 'rejected', 'deleted']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(200).optional() }), req.query)),
  );
  r.post('/cash/deposits', { access: perm('cash.deposit.record') }, async (req, reply) => {
    const res = await s.createDeposit(requireUser(req), keyOf(req.headers), parse(s.depositSchema, req.body), requestMeta(req));
    reply.code(res.statusCode);
    return res.body;
  });
  r.post('/cash/deposits/:id/verify', { access: perm('cash.deposit.verify') }, async (req) => s.decide(requireUser(req), idOf(req), 'verify', null, requestMeta(req)));
  r.post('/cash/deposits/:id/delete', { access: perm('cash.deposit.delete') }, async (req) => {
    const b = parse(z.object({ reason: z.string().trim().min(5).max(500) }), req.body);
    return s.deleteDeposit(requireUser(req), idOf(req), b.reason, requestMeta(req));
  });
  r.post('/cash/deposits/:id/reject', { access: perm('cash.deposit.verify') }, async (req) => {
    const b = parse(z.object({ reason: z.string().trim().min(5).max(500) }), req.body);
    return s.decide(requireUser(req), idOf(req), 'reject', b.reason, requestMeta(req));
  });
  r.post('/cash/closings', { access: perm('cash.deposit.record') }, async (req, reply) => {
    reply.code(201);
    return s.close(requireUser(req), parse(z.object({ businessDate: z.string(), note: z.string().max(500).optional() }), req.body));
  });
});
