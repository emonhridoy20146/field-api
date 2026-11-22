import { z } from 'zod';
import { ctx } from '../../core/context/index.js';
import { AppError, notFound } from '../../core/errors/index.js';
import { isOid } from '../../core/db/index.js';
import { cloudinary, storage, URL_TTL_SEC } from '../../core/storage/index.js';
import { withTransaction } from '../../core/db/index.js';
import { canSeeBranch, type AuthUser } from '../../core/security/types.js';
import { MediaModel } from './models/media.model.js';
import { deletedError, enqueueCopy } from './cloud.js';

export const uploadSchema = z.object({
  kind: z.enum(['visit_photo', 'deposit_slip', 'selfie', 'location_proof', 'refund_proof', 'voice_note']),
  contentType: z.enum(['image/jpeg', 'image/webp', 'audio/aac', 'audio/mp4']),
  sizeBytes: z.number().int().min(1).max(1_048_576),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i, 'hex sha256'),
  capturedAt: z.string().datetime({ offset: true }).optional(),
  geo: z.object({ lat: z.number(), lng: z.number(), accuracyM: z.number() }).passthrough().nullable().optional(),
});

const ext: Record<string, string> = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'audio/aac': 'aac', 'audio/mp4': 'm4a' };
const b64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');

/** FR-MED-001: presigned PUT; the same file (sha256) from the same owner is uploaded once. */
export async function uploadUrl(user: AuthUser, input: z.infer<typeof uploadSchema>, origin?: string) {
  const sha = input.sha256.toLowerCase();
  const kindOk = input.kind === 'voice_note' ? input.contentType.startsWith('audio/') : input.contentType.startsWith('image/');
  if (!kindOk) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'contentType', message: `not allowed for ${input.kind}` }] });
  const now = ctx().clock.now();
  const existing = await MediaModel.findOne({ ownerId: user.id, sha256: sha, kind: input.kind }).lean();
  // The same file again after an admin deleted it: refused, the deletion stands (FR-MED-003/004).
  if (existing?.status === 'deleted') throw new AppError('INVALID_STATE', { reason: 'MEDIA_DELETED' });
  if (existing?.status === 'uploaded') return { mediaId: existing._id.toHexString(), uploadUrl: '', headers: {}, expiresAt: now.toISOString(), alreadyExists: true };
  const doc =
    existing ??
    (await MediaModel.create({
      ownerId: user.id,
      branchId: user.branchIds[0] ?? null,
      kind: input.kind,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      sha256: sha,
      key: `${input.kind}/${user.id}/${sha}.${ext[input.contentType]}`,
      capturedAt: input.capturedAt ? new Date(input.capturedAt) : null,
      geo: input.geo ? { lat: input.geo.lat, lng: input.geo.lng, accuracyM: input.geo.accuracyM } : null,
      createdAt: now,
    }));
  const signed = await storage().presignPut(doc.key, doc.contentType, doc.sizeBytes, b64(sha), origin);
  return { mediaId: doc._id.toHexString(), uploadUrl: signed.url, headers: signed.headers, expiresAt: new Date(now.getTime() + URL_TTL_SEC * 1000).toISOString(), alreadyExists: false };
}

export async function confirm(user: AuthUser, id: string) {
  if (!isOid(id)) throw notFound('media');
  const m = await MediaModel.findOne({ _id: id, ownerId: user.id }).lean();
  if (!m) throw notFound('media');
  if (m.status === 'uploaded') return { id, status: 'uploaded' };
  if (m.status === 'deleted') throw new AppError('INVALID_STATE', { reason: 'MEDIA_DELETED' });
  if (!(await storage().exists(m.key))) throw new AppError('INVALID_STATE', { reason: 'NOT_UPLOADED' });
  // ADR-050: the copy to Cloudinary runs in the outbox, so a Cloudinary outage never fails the confirm.
  await withTransaction(async (session) => {
    const r = await MediaModel.updateOne({ _id: id, status: 'pending' }, { $set: { status: 'uploaded', confirmedAt: ctx().clock.now() } }, { session });
    if (r.modifiedCount === 1) await enqueueCopy(id, m.contentType, session);
  });
  return { id, status: 'uploaded' };
}

/** Owner, or anyone who is not field staff in the media's branch. Out of scope → 404. Never log the URL. */
export async function signedUrl(user: AuthUser, id: string, origin?: string) {
  if (!isOid(id)) throw notFound('media');
  const m = await MediaModel.findById(id).lean();
  const visible = m && (m.ownerId === user.id || (user.role !== 'field_staff' && canSeeBranch(user, m.branchId)));
  if (!m || !visible) throw notFound('media');
  if (m.status === 'deleted') throw deletedError(m);
  if (m.status !== 'uploaded') throw notFound('media');
  if (m.cloud?.publicId) {
    const c = cloudinary();
    // Copied to Cloudinary and the base copy may be gone: without the Cloudinary settings it cannot be read.
    if (!c) throw new AppError('INVALID_STATE', { reason: 'CLOUD_STORAGE_NOT_CONFIGURED' });
    const link = c.downloadUrl(m.cloud.publicId, m.cloud.format ?? 'jpg');
    return { url: link.url, expiresAt: link.expiresAt.toISOString() };
  }
  return { url: await storage().presignGet(m.key, origin), expiresAt: new Date(ctx().clock.now().getTime() + URL_TTL_SEC * 1000).toISOString() };
}

export async function isUploadedBy(id: string, ownerId: string): Promise<boolean> {
  return isOid(id) && !!(await MediaModel.exists({ _id: id, ownerId, status: { $ne: 'deleted' } }));
}
