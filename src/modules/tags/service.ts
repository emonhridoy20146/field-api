import { ctx } from '../../core/context/index.js';
import { AppError, businessRule, notFound } from '../../core/errors/index.js';
import { withTransaction, newId } from '../../core/db/index.js';
import { branchQuery, type AuthUser } from '../../core/security/types.js';
import type { RequestMeta } from '../../core/http/router.js';
import * as audit from '../audit/index.js';
import { getSetting } from '../settings/index.js';
import { can } from '../rbac/index.js';
import { getUsers } from '../users/index.js';
import { customerVersion, getCustomerRef, getCustomerRefs, setTag as writeOverlay } from '../customers/index.js';
import { decide, effective, view, type Tag, type TagRequest } from './domain/tag-rules.js';
import { TagEventModel, TagReviewModel } from './models/tag.model.js';

export interface SetTagInput extends TagRequest {
  geo?: { lat: number; lng: number; accuracyM: number } | undefined;
}

const sourceOf = (user: AuthUser): 'web' | 'app' => (user.client === 'app' ? 'app' : 'web');
const actorName = (user: AuthUser) => user.name?.en || user.name?.bn || '';

/**
 * PUT /customers/:id/tag (FR-TAG-003/007). The event + audit + review are written in one transaction;
 * the customer overlay is a denormalized copy written after commit (rebuildable from the latest event).
 */
export async function setTag(user: AuthUser, customerId: string, input: SetTagInput, ifMatch: number | null, meta: RequestMeta) {
  const c = await getCustomerRef(user, customerId);
  if (!c) throw notFound('customer');
  if (ifMatch !== null) {
    const v = await customerVersion(customerId);
    if (v !== ifMatch) throw new AppError('PRECONDITION_FAILED', { currentVersion: v });
  }
  const current = (c.tag as Tag | null) ?? null;
  const at = ctx().clock.now();
  const requireApproval = (await getSetting<boolean>('tags.requireApproval', c.branchId)) === true;
  const d = decide(current, input, { actorId: user.id, at, requireApproval, canApprove: await can(user, 'tag.approve') });
  if (!d.ok) throw businessRule(d.rule);
  const eventId = newId();
  const previous = effective(current);
  const overlay: Tag = d.mode === 'apply' ? d.next : { ...previous, pendingEventId: eventId };
  await withTransaction(async (session) => {
    // A newer change (or request) supersedes any open request for this customer.
    await TagReviewModel.updateMany({ customerId, kind: 'approval', status: 'open' }, { $set: { status: 'superseded', decidedAt: at } }, { session });
    await TagEventModel.create(
      [
        {
          _id: eventId,
          customerId,
          branchId: c.branchId,
          kind: d.mode === 'apply' ? 'change' : 'request',
          previous,
          next: d.next,
          reasonCode: input.reasonCode,
          reason: input.reason.trim(),
          actorId: user.id,
          actorName: actorName(user),
          actorRole: user.role,
          source: sourceOf(user),
          deviceLocation: input.geo ? { lat: input.geo.lat, lng: input.geo.lng, accuracyM: input.geo.accuracyM } : null,
          at,
        },
      ],
      { session },
    );
    if (d.mode === 'request')
      await TagReviewModel.create([{ _id: eventId, customerId, branchId: c.branchId, kind: 'approval', requested: d.next, requestedBy: user.id, createdAt: at }], { session });
    await audit.record(
      { actor: user, action: d.mode === 'apply' ? 'tag.changed' : 'tag.requested', entity: 'customer', entityId: customerId, branchId: c.branchId, before: view(previous), after: view(d.next), reason: input.reason, meta },
      session,
    );
  });
  await writeOverlay(customerId, overlay as unknown as Record<string, unknown>);
  if (d.mode === 'apply') await ctx().bus.emit('tag.changed', { customerId, branchId: c.branchId, state: d.next.state, severity: d.next.severity ?? null, eventId });
  else await ctx().bus.emit('tag.review_requested', { customerId, branchId: c.branchId, kind: 'approval', eventId, requestedBy: user.id });
  return { tag: view(overlay), eventId };
}

export async function history(user: AuthUser, customerId: string) {
  const c = await getCustomerRef(user, customerId);
  if (!c) throw notFound('customer');
  const rows = await TagEventModel.find({ customerId }).sort({ at: -1, _id: -1 }).limit(200).lean();
  return rows.map((e) => ({
    id: String(e._id),
    kind: e.kind,
    previous: view((e.previous as Tag | null) ?? null),
    next: view((e.next as Tag | null) ?? null),
    reasonCode: e.reasonCode ?? '',
    reason: e.reason ?? '',
    actor: { id: e.actorId ?? 'system', name: e.actorName ?? 'system', role: e.actorRole ?? 'system' },
    source: e.source,
    ...(e.deviceLocation ? { deviceLocation: e.deviceLocation } : {}),
    ...(e.approvalOf ? { approvalOf: e.approvalOf } : {}),
    at: e.at.toISOString(),
  }));
}

export async function reviewQueue(user: AuthUser, branchId?: string) {
  const rows = await TagReviewModel.find({ status: 'open', ...branchQuery(user, branchId) }).sort({ createdAt: 1 }).limit(500).lean();
  const refs = await getCustomerRefs(rows.map((r) => r.customerId));
  const users = await getUsers(rows.map((r) => r.requestedBy).filter((x): x is string => !!x));
  return {
    items: rows.map((r) => {
      const c = refs.get(r.customerId);
      const by = r.requestedBy ? users.get(r.requestedBy) : undefined;
      return {
        eventId: String(r._id),
        kind: r.kind,
        customer: c ? { id: c.id, code: c.code, name: c.name, totalOutstandingPoisha: c.totalOutstandingPoisha, tag: view((c.tag as Tag | null) ?? null) } : { id: r.customerId },
        ...(r.requested ? { requested: view(r.requested as Tag) } : {}),
        ...(by ? { requestedBy: { id: by.id, name: by.name.en || by.name.bn } } : {}),
        createdAt: r.createdAt.toISOString(),
      };
    }),
  };
}

/**
 * Decide a review item.
 * - approval: approve → the requested tag applies; reject → the request is dropped (tag in force unchanged).
 * - balance_cleared: approve → untag (reason `cleared`); reject → keep the tag (e.g. legal case continues).
 */
export async function decideReview(user: AuthUser, eventId: string, input: { decision: 'approve' | 'reject'; reason?: string | undefined }, meta: RequestMeta) {
  const r = await TagReviewModel.findOne({ _id: eventId, ...branchQuery(user, undefined) }).lean();
  if (!r) throw notFound('tag_review');
  if (r.status !== 'open') throw new AppError('INVALID_STATE', { reason: 'ALREADY_DECIDED' });
  if (input.decision === 'reject' && (input.reason ?? '').trim().length < 5) throw businessRule('REASON_REQUIRED');
  const c = await getCustomerRef(null, r.customerId);
  if (!c) throw notFound('customer');
  const at = ctx().clock.now();
  const current = (c.tag as Tag | null) ?? null;
  const previous = effective(current);
  let next: Tag = previous;
  if (input.decision === 'approve') {
    if (r.kind === 'approval') next = { ...(r.requested as Tag), setAt: at };
    else next = { state: 'none', reasonCode: 'cleared', reason: input.reason?.trim() || 'Balance cleared in ERP; tag removed on review', setBy: user.id, setAt: at };
  }
  const decisionEventId = newId();
  await withTransaction(async (session) => {
    const upd = await TagReviewModel.updateOne(
      { _id: eventId, status: 'open' },
      { $set: { status: input.decision === 'approve' ? 'approved' : 'rejected', decidedBy: user.id, decidedAt: at, decisionReason: input.reason ?? null } },
      { session },
    );
    if (upd.modifiedCount !== 1) throw new AppError('INVALID_STATE', { reason: 'ALREADY_DECIDED' });
    await TagEventModel.create(
      [
        {
          _id: decisionEventId,
          customerId: r.customerId,
          branchId: r.branchId,
          kind: 'decision',
          previous,
          next,
          reasonCode: input.decision === 'approve' ? (next.reasonCode ?? '') : 'rejected',
          reason: input.reason ?? '',
          actorId: user.id,
          actorName: actorName(user),
          actorRole: user.role,
          source: sourceOf(user),
          approvalOf: eventId,
          at,
        },
      ],
      { session },
    );
    await audit.record(
      { actor: user, action: `tag.review.${input.decision === 'approve' ? 'approved' : 'rejected'}`, entity: 'customer', entityId: r.customerId, branchId: r.branchId, before: view(previous), after: view(next), reason: input.reason ?? null, meta },
      session,
    );
  });
  await writeOverlay(r.customerId, next as unknown as Record<string, unknown>);
  if (next !== previous) await ctx().bus.emit('tag.changed', { customerId: r.customerId, branchId: r.branchId, state: next.state, severity: next.severity ?? null, eventId: decisionEventId });
  await ctx().bus.emit('tag.review_decided', { eventId, customerId: r.customerId, kind: r.kind, decision: input.decision, requestedBy: r.requestedBy });
  return { eventId, status: input.decision === 'approve' ? 'approved' : 'rejected', tag: view(next) };
}

/** FR-TAG-005: balance cleared on a tagged customer → system event + review item (once while open). */
export async function onBalanceCleared(p: { customerId: string; branchId: string | null; tagged: boolean }): Promise<void> {
  if (!p.tagged) return;
  if (await TagReviewModel.exists({ customerId: p.customerId, kind: 'balance_cleared', status: 'open' })) return;
  const c = await getCustomerRef(null, p.customerId);
  if (!c) return;
  const at = ctx().clock.now();
  const eventId = newId();
  const tag = effective((c.tag as Tag | null) ?? null);
  await withTransaction(async (session) => {
    await TagEventModel.create(
      [{ _id: eventId, customerId: p.customerId, branchId: c.branchId, kind: 'review_requested', previous: tag, next: tag, reasonCode: 'cleared', reason: 'Balance cleared in ERP — review tag', source: 'system', at }],
      { session },
    );
    await TagReviewModel.create([{ _id: eventId, customerId: p.customerId, branchId: c.branchId, kind: 'balance_cleared', createdAt: at }], { session });
  });
  await ctx().bus.emit('tag.review_requested', { customerId: p.customerId, branchId: c.branchId, kind: 'balance_cleared', eventId });
}
