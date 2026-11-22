import { createHmac } from 'node:crypto';
import { DeleteObjectCommand, HeadObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { cloudinaryConfigured, type Config } from '../config/index.js';
import { cloudinary } from './cloudinary.js';
import { CloudinaryStorage } from './cloudinary-storage.js';
import { DbStorage, storageSecret } from './db-storage.js';
import { URL_TTL_SEC, type ObjectStorage } from './types.js';

export { URL_TTL_SEC, type ObjectStorage } from './types.js';
export { CloudinaryStorage, CLOUD_RECORDS, CLOUD_UPLOAD_TIMEOUT_MS } from './cloudinary-storage.js';
export { CloudinaryClient, CloudinaryError, cloudinary, setCloudinary, cloudinaryFromConfig, signParams, CLOUD_DELETE_CHUNK, type CloudUpload, type FetchLike } from './cloudinary.js';

export class S3Storage implements ObjectStorage {
  private s3: S3Client;
  constructor(
    private bucket: string,
    cfg: { endpoint?: string | undefined; region: string; accessKeyId?: string | undefined; secretAccessKey?: string | undefined },
  ) {
    this.s3 = new S3Client({
      region: cfg.region,
      ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
      ...(cfg.accessKeyId && cfg.secretAccessKey ? { credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } } : {}),
    });
  }
  async presignPut(key: string, contentType: string, sizeBytes: number, sha256Base64: string) {
    const cmd = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: sizeBytes, ChecksumSHA256: sha256Base64 });
    const url = await getSignedUrl(this.s3, cmd, { expiresIn: URL_TTL_SEC });
    return { url, headers: { 'Content-Type': contentType, 'x-amz-checksum-sha256': sha256Base64 } };
  }
  async presignGet(key: string) {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: URL_TTL_SEC });
  }
  async put(key: string, body: Uint8Array, contentType: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }
  async get(key: string) {
    try {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!r.Body) return null;
      return { body: await r.Body.transformToByteArray(), contentType: r.ContentType ?? 'application/octet-stream' };
    } catch (e) {
      if ((e as { name?: string }).name === 'NoSuchKey') return null;
      throw e;
    }
  }
  async delete(key: string) {
    // S3 DeleteObject succeeds for a missing key too.
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
  async exists(key: string) {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }
}

/** Dev/test storage: signed fake URLs, objects "exist" once markUploaded() is called. Never used in production. */
export class MemoryStorage implements ObjectStorage {
  readonly uploaded = new Set<string>();
  readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();
  async put(key: string, body: Uint8Array, contentType: string) {
    this.objects.set(key, { body, contentType });
    this.uploaded.add(key);
  }
  async presignPut(key: string, contentType: string) {
    return { url: `memory://upload/${encodeURIComponent(key)}?sig=${createHmac('sha256', 'dev').update(key).digest('hex').slice(0, 16)}`, headers: { 'Content-Type': contentType } };
  }
  async presignGet(key: string) {
    return `memory://get/${encodeURIComponent(key)}`;
  }
  async exists(key: string) {
    return this.uploaded.has(key);
  }
  markUploaded(key: string) {
    this.uploaded.add(key);
  }
  async get(key: string) {
    return this.objects.get(key) ?? null;
  }
  async delete(key: string) {
    this.objects.delete(key);
    this.uploaded.delete(key);
  }
}

let current: ObjectStorage | null = null;
export function storage(): ObjectStorage {
  if (!current) throw new Error('storage not initialised');
  return current;
}
export function setStorage(s: ObjectStorage) {
  current = s;
}
/**
 * Which store files go to. `STORAGE_DRIVER` wins; otherwise Cloudinary first on Vercel when its three settings
 * are present (ADR-051, owner request: photos go to Cloudinary at once), S3 when it is configured, the database
 * on Vercel (no S3 there means every instance would have its own in-memory files, ADR-039), S3 in production
 * (fails loudly without credentials), and memory for local development and tests.
 */
export type StorageDriver = 's3' | 'db' | 'memory' | 'cloudinary';
export function storageDriver(config: Config): StorageDriver {
  // On Vercel a leftover `STORAGE_DRIVER=s3` without real S3 keys is ignored (owner 2026-11-22: S3 is not used there).
  if (config.STORAGE_DRIVER && !(config.VERCEL && config.STORAGE_DRIVER === 's3' && !s3Configured(config))) return config.STORAGE_DRIVER;
  if (config.VERCEL && cloudinaryConfigured(config)) return 'cloudinary';
  if (s3Configured(config)) return 's3';
  if (config.VERCEL) return 'db';
  return config.NODE_ENV === 'production' ? 's3' : 'memory';
}

/** S3 counts as set up only with both keys; an endpoint or a key id alone used to select it and broke uploads. */
export const s3Configured = (config: Pick<Config, 'S3_ACCESS_KEY_ID' | 'S3_SECRET_ACCESS_KEY'>) => !!(config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY);
const s3From = (config: Config) =>
  new S3Storage(config.S3_BUCKET_MEDIA, { endpoint: config.S3_ENDPOINT, region: config.S3_REGION, accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY });

export function storageFromConfig(config: Config, now: () => Date): ObjectStorage {
  const driver = storageDriver(config);
  if (driver === 'memory') return new MemoryStorage();
  const db = { baseUrl: config.PUBLIC_BASE_URL.replace(/\/+$/, ''), secret: storageSecret(config.JWT_PRIVATE_KEY), now };
  if (driver === 'db') return new DbStorage(db);
  // Old photos uploaded to S3 before the switch are still read (and deleted) there while the S3 settings stay.
  if (driver === 'cloudinary') return new CloudinaryStorage({ ...db, cloud: cloudinary, legacy: s3Configured(config) ? s3From(config) : null });
  return s3From(config);
}
