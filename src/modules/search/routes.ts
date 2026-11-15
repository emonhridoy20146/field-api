import { z } from 'zod';
import { defineRoutes, hasPermission, requireUser } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import { isEnabledForUser } from '../flags/index.js';
import { searchCustomers } from '../customers/index.js';
import { searchUsers } from '../users/index.js';
import { searchReceipts } from '../collections/index.js';

const TYPES = ['customer', 'user', 'receipt'] as const;
const query = z.object({
  q: z.string().trim().min(2).max(60),
  types: z
    .string()
    .max(40)
    .optional()
    .transform((v) => (v ? v.split(',').map((x) => x.trim()) : [...TYPES]))
    .pipe(z.array(z.enum(TYPES)).min(1)),
});

/**
 * FR-SRCH-001 global search. Self-service route: each result type is included only when the caller
 * holds that type's own view permission and its module is on, and each source applies its own scope.
 */
export const searchRoutes = defineRoutes((r) => {
  r.get('/search', { access: 'self' }, async (req) => {
    const user = requireUser(req);
    const { q, types } = parse(query, req.query);
    const out: { type: string; id: string; title: string; subtitle: string }[] = [];
    if (types.includes('customer') && (await hasPermission(req, 'customer.view')) && (await isEnabledForUser('module.customers', user))) out.push(...(await searchCustomers(user, q, 8)));
    if (types.includes('user') && (await hasPermission(req, 'user.view'))) out.push(...(await searchUsers(user, q, 5)));
    if (types.includes('receipt') && (await hasPermission(req, 'collection.view')) && (await isEnabledForUser('module.collections', user))) out.push(...(await searchReceipts(user, q, 5)));
    return out;
  });
});
