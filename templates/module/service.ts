import { ctx } from '../../core/context/index.js';
import { branchQuery, type AuthUser } from '../../core/security/types.js';
import { type LeanDoc } from '../../core/db/index.js';
import { ThingModel } from './models/thing.model.js';

const view = (d: LeanDoc) => ({ id: d._id.toHexString(), createdAt: (d.createdAt as Date).toISOString() });

/** Every query on customer-linked data applies the caller's scope; out of scope is 404, never 403. */
export async function list(user: AuthUser, q: { branchId?: string | undefined }) {
  const rows = (await ThingModel.find(branchQuery(user, q.branchId)).sort({ _id: -1 }).limit(100).lean()) as LeanDoc[];
  return { items: rows.map(view), serverTime: ctx().clock.now().toISOString() };
}
