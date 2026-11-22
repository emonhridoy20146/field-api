import { z } from 'zod';
import type { ClientSession } from 'mongoose';
import { ctx } from '../../core/context/index.js';
import { AppError, businessRule } from '../../core/errors/index.js';
import { newId, withTransaction, type LeanDoc } from '../../core/db/index.js';
import { cancelPending, enqueue, type OutboxResult } from '../../core/events/outbox.js';
import { CLOUD_DELETE_CHUNK, cloudinary, storage } from '../../core/storage/index.js';
import { branchFilter, type AuthUser } from '../../core/security/types.js';
import { businessDate, startOfBusinessDay, BUSINESS_TZ } from '../../core/time/index.js';
import type { RequestMeta } from '../../core/http/router.js';
import * as audit from '../audit/index.js';
import { MediaModel } from './models/media.model.js';
import { chunk, confirmTextFor, isPastOrCurrentMonth, PURGE_BATCH, purgeKinds, shouldSuggest, type DeleteScope } from './domain/purge.js';

/**
 * ADR-050: photos go to Cloudinary after upload; admins delete old photos and the photos of an attendance day.
 * Both stores are cleaned by the outbox (`media.remote_delete`), tried once at once and retried in the background.
 */
export const COPY_JOB = 'media.cloud_copy';
export const REMOTE_DELETE_JOB = 'media.remote_delete';

const now = () => ctx().clock.now();
const nameOf = (u: AuthUser) => u.name.en || u.name.bn || u.employeeCode;

// ---------------- copy to Cloudinary ----------------

/** Queued by confirm when Cloudinary is configured; a no-op for anything that is not a confirmed photo. */
export async function enqueueCopy(mediaId: string, contentType: string, session?: ClientSession): Promise<void> {
  if (!cloudinary() || !contentType.startsWith('image/')) return;
  await enqueue(COPY_JOB, { mediaId }, session);
}

export async function copyToCloud(payload: Record<string, unknown>): Promise<OutboxResult> {
  const c = cloudinary();
  if (!c) return { status: 'done' }; // turned off meanwhile: the base copy stays and is used
  const m = (await MediaModel.findById(String(payload.mediaId)).lean()) as LeanDoc | null;
  if (!m || m.status !== 'uploaded') return { status: 'done' };
  if (!m.cloud) {
    const obj = await storage().get(m.key as string);
    if (!obj) return { status: 'failed', error: 'BASE_OBJECT_MISSING' };
    const up = await c.upload(obj.body, m.contentType as string, c.publicIdFor(m.key as string)); // throws → retried with backoff
    const set = await MediaModel.updateOne({ _id: m._id, status: 'uploaded', cloud: null }, { $set: { cloud: { provider: 'cloudinary', ...up, copiedAt: now() } } });
    if (set.modifiedCount === 0) {
      // Deleted while we were uploading: remove what we just put there.
      const again = (await MediaModel.findById(m._id).lean()) as LeanDoc | null;
      if (!again || again.status === 'deleted') await c.deleteMany([up.publicId]);
      return { status: 'done' };
    }
  }
  if (!m.baseRemovedAt) {
    // Reads now use Cloudinary; the base copy only costs hosting space. A failure here is retried.
    await storage().delete(m.key as string);
    await MediaModel.updateOne({ _id: m._id }, { $set: { baseRemovedAt: now() } });
  }
  return { status: 'done' };
}

// ---------------- delete ----------------

export interface DeleteInfo {
  scope: DeleteScope;
  reason?: string | null;
}

/**
 * Marks the rows deleted (at once: their links answer 404 `MEDIA_DELETED`) and queues the removal of their files, in the
 * caller's transaction. Returns the outbox batches for {@link removeNow}.
 */
export interface RemovalBatch {
  batchId: string;
  mediaIds: string[];
}

export async function markDeleted(ids: string[], actor: AuthUser, info: DeleteInfo, session: ClientSession): Promise<{ count: number; batches: RemovalBatch[] }> {
  if (!ids.length) return { count: 0, batches: [] };
  const deleted = { at: now(), by: actor.id, byName: nameOf(actor), reason: info.reason ?? null, scope: info.scope, filesRemovedAt: null };
  const res = await MediaModel.updateMany({ _id: { $in: ids }, status: { $ne: 'deleted' } }, { $set: { status: 'deleted', deleted } }, { session });
  const batches = chunk(ids, CLOUD_DELETE_CHUNK).map((mediaIds) => ({ batchId: newId(), mediaIds }));
  for (const b of batches) await enqueue(REMOTE_DELETE_JOB, { ...b }, session);
  return { count: res.modifiedCount, batches };
}

/** Removes the files of deleted rows from Cloudinary and from the base store. Repeatable. */
export async function removeFiles(mediaIds: string[]): Promise<void> {
  const rows = (await MediaModel.find({ _id: { $in: mediaIds }, status: 'deleted', 'deleted.filesRemovedAt': null }).lean()) as LeanDoc[];
  if (!rows.length) return;
  const inCloud = rows.filter((r) => r.cloud?.publicId).map((r) => r.cloud.publicId as string);
  if (inCloud.length) {
    const c = cloudinary();
    if (!c) throw new Error('cloudinary not configured; photos copied there cannot be removed yet');
    for (const ids of chunk(inCloud, CLOUD_DELETE_CHUNK)) await c.deleteMany(ids);
  }
  // A row whose base copy is already gone (copied, or uploaded straight to Cloudinary, ADR-053) has nothing there: skip
  // it, so the store is not asked for a file it never had (with the Cloudinary-first store that would reach S3).
  const inBase = rows.filter((r) => !r.baseRemovedAt);
  for (const group of chunk(inBase, 20)) await Promise.all(group.map((r) => storage().delete(r.key as string)));
  await MediaModel.updateMany({ _id: { $in: rows.map((r) => r._id) } }, { $set: { 'deleted.filesRemovedAt': now() } });
}

export async function remoteDeleteJob(payload: Record<string, unknown>): Promise<OutboxResult> {
  const ids = Array.isArray(payload.mediaIds) ? payload.mediaIds.map(String) : [];
  await removeFiles(ids); // throws → retried with backoff
  return { status: 'done' };
}

/** Tries the queued removals right away; whatever fails stays in the outbox and is retried. Never throws. */
export async function removeNow(batches: RemovalBatch[]): Promise<void> {
  for (const { batchId, mediaIds } of batches) {
    try {
      await removeFiles(mediaIds);
      await cancelPending(REMOTE_DELETE_JOB, { batchId });
    } catch (err) {
      ctx().logger.warn({ err: err instanceof Error ? err.message : String(err), count: mediaIds.length }, 'media file removal deferred to the outbox');
    }
  }
}

// ---------------- purge of previous months (FR-MED-003) ----------------

const month = z.string().regex(/^\d{4}-\d{2}$/, 'YYYY-MM');
const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true');
export const previewSchema = z.object({ before: month.optional(), includeMoneyProofs: boolQuery.optional() });
export const purgeSchema = z.object({ before: month, includeMoneyProofs: z.boolean().optional(), confirmText: z.string().max(40) });

function purgeFilter(user: AuthUser, before: string, includeMoneyProofs: boolean) {
  const today = businessDate(now());
  if (!isPastOrCurrentMonth(before, today)) throw businessRule('NOT_A_PAST_MONTH', { before, currentMonth: today.slice(0, 7) });
  const cutoff = startOfBusinessDay(`${before}-01`);
  const kinds = purgeKinds(includeMoneyProofs);
  return { today, cutoff, kinds, filter: { kind: { $in: kinds }, status: { $in: ['pending', 'uploaded'] }, createdAt: { $lt: cutoff }, ...branchFilter(user) } };
}

export async function purgePreview(user: AuthUser, q: z.infer<typeof previewSchema>) {
  const before = q.before ?? businessDate(now()).slice(0, 7);
  const includeMoneyProofs = q.includeMoneyProofs ?? false;
  const { today, cutoff, kinds, filter } = purgeFilter(user, before, includeMoneyProofs);
  const rows = (await MediaModel.aggregate([
    { $match: filter },
    { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: BUSINESS_TZ } }, count: { $sum: 1 }, bytes: { $sum: '$sizeBytes' } } },
    { $sort: { _id: 1 } },
  ])) as { _id: string; count: number; bytes: number }[];
  const months = rows.map((r) => ({ month: r._id, count: r.count, bytes: r.bytes }));
  const total = months.reduce((a, m) => ({ count: a.count + m.count, bytes: a.bytes + m.bytes }), { count: 0, bytes: 0 });
  return { before, cutoff: cutoff.toISOString(), today, kinds, includeMoneyProofs, months, total, suggest: shouldSuggest(today, total.count) };
}

export async function purge(user: AuthUser, input: z.infer<typeof purgeSchema>, meta: RequestMeta) {
  const includeMoneyProofs = input.includeMoneyProofs ?? false;
  const { cutoff, kinds, filter } = purgeFilter(user, input.before, includeMoneyProofs);
  if (input.confirmText !== confirmTextFor(input.before)) throw businessRule('CONFIRM_TEXT_MISMATCH', { expected: confirmTextFor(input.before) });
  const rows = (await MediaModel.find(filter, { _id: 1, sizeBytes: 1 }).sort({ createdAt: 1 }).limit(PURGE_BATCH).lean()) as LeanDoc[];
  const ids = rows.map((r) => r._id.toHexString() as string);
  const bytes = rows.reduce((a, r) => a + Number(r.sizeBytes ?? 0), 0);
  const { count, batches } = await withTransaction(async (session) => {
    const r = await markDeleted(ids, user, { scope: 'purge', reason: `previous months before ${input.before}` }, session);
    if (r.count)
      await audit.record(
        { actor: user, action: 'media.purged', entity: 'media', entityId: `purge:${input.before}:${newId()}`, branchId: null, after: { before: input.before, cutoff, kinds, deleted: r.count, bytes }, reason: input.confirmText, meta },
        session,
      );
    return r;
  });
  await removeNow(batches);
  const remaining = await MediaModel.countDocuments(filter);
  return { deleted: count, bytes, remaining };
}

/** 404 detail for a deleted photo (FR-MED-004 log). */
export function deletedError(m: LeanDoc): AppError {
  return new AppError('NOT_FOUND', { entity: 'media', reason: 'MEDIA_DELETED', deletedAt: m.deleted?.at ? (m.deleted.at as Date).toISOString() : null, deletedByName: m.deleted?.byName ?? null });
}
