import { z } from 'zod';
import { defineRoutes, perm, requestMeta, requireUser } from '../../core/http/router.js';
import { parse, parseIfMatch } from '../../core/http/index.js';
import { TAG_REASONS } from './domain/tag-rules.js';
import * as s from './service.js';

const tagBody = z.object({
  state: z.enum(['tagged', 'none']),
  severity: z.enum(['watch', 'bad', 'legal']).optional(),
  reasonCode: z.enum(TAG_REASONS),
  reason: z.string().trim().min(10).max(1000),
  geo: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().min(0) }).passthrough().optional(),
});
const decisionBody = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().max(1000).optional() });
const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;

export const tagRoutes = defineRoutes((r) => {
  r.put('/customers/:id/tag', { access: perm('tag.set') }, async (req) =>
    s.setTag(requireUser(req), idOf(req), parse(tagBody, req.body), parseIfMatch(req.headers['if-match'] as string | undefined), requestMeta(req)),
  );
  r.get('/customers/:id/tag-history', { access: perm('tag.view') }, async (req) => s.history(requireUser(req), idOf(req)));
  r.get('/tags/review-queue', { access: perm('tag.approve') }, async (req) => {
    const q = parse(z.object({ branchId: z.string().max(64).optional() }), req.query);
    return s.reviewQueue(requireUser(req), q.branchId);
  });
  r.post('/tags/review-queue/:eventId/decision', { access: perm('tag.approve') }, async (req) =>
    s.decideReview(requireUser(req), (req.params as { eventId: string }).eventId, parse(decisionBody, req.body), requestMeta(req)),
  );
});
