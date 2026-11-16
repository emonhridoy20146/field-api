import { z } from 'zod';
import { defineRoutes, perm, requestMeta, requireUser } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import { AppError } from '../../core/errors/index.js';
import * as s from './service.js';
import { allocateBlock, blockSchemaIn } from './receipts.js';

const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
const keyOf = (req: { headers: Record<string, unknown> }) => {
  const k = req.headers['idempotency-key'];
  const ok = typeof k === 'string' && z.string().uuid().safeParse(k).success;
  if (!ok) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'Idempotency-Key', message: 'UUID header required' }] });
  return k as string;
};

export const collectionRoutes = defineRoutes((r) => {
  r.post('/collections', { access: perm('collection.record') }, async (req, reply) => {
    const res = await s.record(requireUser(req), keyOf(req), parse(s.createSchema, req.body), requestMeta(req));
    reply.code(res.statusCode);
    return res.body;
  });
  r.get('/collections', { access: perm('collection.view') }, async (req) => s.list(requireUser(req), parse(s.listSchema, req.query)));
  r.get('/collections/conflicts', { access: perm('collection.view') }, async (req) => {
    const q = parse(z.object({ branchId: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(200).optional() }), req.query);
    return s.conflicts(requireUser(req), q);
  });
  r.get('/collections/:id', { access: perm('collection.view') }, async (req) => s.get(requireUser(req), idOf(req)));
  r.post('/collections/:id/void', { access: perm('collection.void') }, async (req) => {
    const b = parse(z.object({ reason: z.string().trim().min(5).max(500) }), req.body);
    return s.voidCollection(requireUser(req), idOf(req), b.reason, requestMeta(req));
  });
  r.post('/collections/:id/resolve', { access: perm('collection.resolve') }, async (req) => s.resolve(requireUser(req), idOf(req), keyOf(req), parse(s.resolveSchema, req.body), requestMeta(req)));
  r.post('/receipts/blocks', { access: perm('collection.record') }, async (req, reply) => {
    reply.code(201);
    return allocateBlock(requireUser(req), parse(blockSchemaIn, req.body));
  });
});
