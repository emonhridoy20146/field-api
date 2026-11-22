import { ctx } from '../context/index.js';
import { db } from '../db/index.js';
import { AppError } from '../errors/index.js';
import type { CloudinaryClient, CloudUpload } from './cloudinary.js';
import { DbStorage, type DbStorageOptions } from './db-storage.js';
import type { ObjectStorage } from './types.js';

/**
 * Driver `cloudinary` (ADR-053): the phone's upload goes to Cloudinary at once, through the API.
 *
 * The phone protocol does not change: `presignPut` hands out the same signed `/api/v1/storage/o` link as the
 * MongoDB store (5 minutes; type, size and sha256 checked by the route). When the bytes arrive, a photo is
 * uploaded to Cloudinary there and then (delivery type `authenticated`) and a small record `key → public id`
 * is kept until the confirm moves it onto the media row. If Cloudinary fails or is not configured, the bytes
 * are kept in MongoDB instead, so the phone's upload never fails; the copy job (`media.cloud_copy`) moves
 * them later. Server-side files (exports) and voice notes stay in MongoDB.
 *
 * Files stored before the switch stay readable: a key that is neither in Cloudinary nor in MongoDB is read
 * from (and deleted from) the previous store, S3, when its settings are still present.
 */
export const CLOUD_RECORDS = 'storage_cloud_objects';
/** The phone is waiting: past this the bytes go to MongoDB instead. Well under Vercel's function limit. */
export const CLOUD_UPLOAD_TIMEOUT_MS = 15_000;

interface CloudRecord {
  _id: string;
  publicId: string;
  version: number;
  bytes: number;
  format: string;
  contentType: string;
  storedAt: Date;
}

export interface CloudinaryStorageOptions extends DbStorageOptions {
  /** The configured client, or null; read on every call so a change of settings in tests is seen. */
  cloud: () => CloudinaryClient | null;
  /** The store used before the switch (S3), for old files; null when there was none. */
  legacy: ObjectStorage | null;
}

export class CloudinaryStorage extends DbStorage {
  constructor(private readonly c: CloudinaryStorageOptions) {
    super(c);
  }

  get legacy(): ObjectStorage | null {
    return this.c.legacy;
  }

  private records() {
    return db().collection<CloudRecord>(CLOUD_RECORDS);
  }

  private record(key: string) {
    return this.records().findOne({ _id: key });
  }

  override async receive(key: string, body: Uint8Array, contentType: string): Promise<void> {
    const cloud = this.c.cloud();
    if (cloud && contentType.startsWith('image/')) {
      try {
        const up = await cloud.upload(body, contentType, cloud.publicIdFor(key), CLOUD_UPLOAD_TIMEOUT_MS);
        await this.records().updateOne({ _id: key }, { $set: { ...up, contentType, storedAt: this.opts.now() } }, { upsert: true });
        await this.deleteLocal(key); // an earlier attempt may have fallen back to MongoDB
        return;
      } catch (err) {
        // Never the URL or the secret: CloudinaryError carries only the status and Cloudinary's message.
        ctx().logger.warn({ err: err instanceof Error ? err.message : String(err), kind: key.split('/')[0] }, 'cloudinary upload failed; photo kept in MongoDB, the copy job retries');
      }
    }
    await this.put(key, body, contentType);
  }

  async cloudUpload(key: string): Promise<CloudUpload | null> {
    const r = await this.record(key);
    return r ? { publicId: r.publicId, version: r.version, bytes: r.bytes, format: r.format } : null;
  }

  async forgetCloudUpload(key: string): Promise<void> {
    await this.records().deleteOne({ _id: key });
  }

  override async exists(key: string): Promise<boolean> {
    if (await this.record(key)) return true;
    if (await super.exists(key)) return true;
    return this.c.legacy ? this.c.legacy.exists(key) : false;
  }

  override async presignGet(key: string, origin?: string): Promise<string> {
    const r = await this.record(key);
    if (r) {
      const cloud = this.c.cloud();
      if (!cloud) throw new AppError('INVALID_STATE', { reason: 'CLOUD_STORAGE_NOT_CONFIGURED' });
      return cloud.downloadUrl(r.publicId, r.format).url;
    }
    if (this.c.legacy && !(await super.exists(key))) return this.c.legacy.presignGet(key, origin);
    return super.presignGet(key, origin);
  }

  override async get(key: string) {
    const local = await super.get(key);
    if (local) return local;
    const old = this.c.legacy ? await this.c.legacy.get(key) : null;
    return old ? { body: Buffer.from(old.body), contentType: old.contentType } : null;
  }

  /** Removes the file wherever it is; the previous store is asked only for a key found nowhere else. */
  override async delete(key: string): Promise<void> {
    const r = await this.record(key);
    if (r) {
      const cloud = this.c.cloud();
      if (!cloud) throw new Error('cloudinary not configured; a photo uploaded there cannot be removed yet');
      await cloud.deleteMany([r.publicId]);
      await this.records().deleteOne({ _id: key });
    }
    const hadLocal = await this.deleteLocal(key);
    if (!r && !hadLocal && this.c.legacy) await this.c.legacy.delete(key);
  }
}
