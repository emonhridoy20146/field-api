import { createHmac } from 'node:crypto';
import { HeadObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from '../config/index.js';
import { DbStorage, storageSecret } from './db-storage.js';
import { URL_TTL_SEC, type ObjectStorage } from './types.js';

export { URL_TTL_SEC, type ObjectStorage } from './types.js';

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
 * Which store files go to. `STORAGE_DRIVER` wins; otherwise S3 when it is configured, the database on
 * Vercel (no S3 there means every instance would have its own in-memory files, ADR-039), S3 in
 * production (fails loudly without credentials), and memory for local development and tests.
 */
export function storageDriver(config: Config): 's3' | 'db' | 'memory' {
  if (config.STORAGE_DRIVER) return config.STORAGE_DRIVER;
  if (config.S3_ENDPOINT || config.S3_ACCESS_KEY_ID) return 's3';
  if (config.VERCEL) return 'db';
  return config.NODE_ENV === 'production' ? 's3' : 'memory';
}

export function storageFromConfig(config: Config, now: () => Date): ObjectStorage {
  const driver = storageDriver(config);
  if (driver === 'memory') return new MemoryStorage();
  if (driver === 'db') return new DbStorage({ baseUrl: config.PUBLIC_BASE_URL.replace(/\/+$/, ''), secret: storageSecret(config.JWT_PRIVATE_KEY), now });
  return new S3Storage(config.S3_BUCKET_MEDIA, { endpoint: config.S3_ENDPOINT, region: config.S3_REGION, accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY });
}
