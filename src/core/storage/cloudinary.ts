import { createHash } from 'node:crypto';
import { cloudinaryConfigured, type Config } from '../config/index.js';
import { URL_TTL_SEC } from './types.js';

/**
 * Photos in the company's Cloudinary account (ADR-050). Plain REST calls with `fetch`, no SDK:
 *  - upload: signed server-side upload, delivery type `authenticated`, so nothing is public;
 *  - read: a signed private download link that expires after 5 minutes (`expires_at`), like S3 presigned GETs;
 *  - delete: Admin API bulk delete (up to 100 public ids per call, basic auth, `invalidate=true` clears the CDN).
 * Signature (Cloudinary "signed uploads"): the parameters except file, cloud_name, resource_type and api_key, sorted
 * by name, joined as `k=v&k=v`, followed by the API secret, SHA-1 hex. The secret never leaves this file: it is not
 * logged and error messages carry only the HTTP status and Cloudinary's message.
 */
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: FormData | string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface CloudinaryOptions {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  folder: string;
  now: () => Date;
  fetch?: FetchLike;
}

export interface CloudUpload {
  publicId: string;
  version: number;
  bytes: number;
  format: string;
}

export const CLOUD_DELETE_CHUNK = 100;
const API = 'https://api.cloudinary.com/v1_1';

export function signParams(params: Record<string, string | number>, secret: string): string {
  const payload = Object.keys(params)
    .filter((k) => !['file', 'cloud_name', 'resource_type', 'api_key'].includes(k) && params[k] !== '' && params[k] !== undefined)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return createHash('sha1').update(payload + secret).digest('hex');
}

export class CloudinaryError extends Error {
  constructor(
    readonly op: string,
    readonly status: number,
    detail?: string,
  ) {
    super(`cloudinary ${op} failed: HTTP ${status}${detail ? ` ${detail.slice(0, 200)}` : ''}`);
  }
}

const errorText = async (res: { json: () => Promise<unknown> }) => {
  try {
    const b = (await res.json()) as { error?: { message?: string } };
    return b?.error?.message;
  } catch {
    return undefined;
  }
};

export class CloudinaryClient {
  private readonly fetch: FetchLike;
  constructor(private readonly o: CloudinaryOptions) {
    this.fetch = o.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  get folder() {
    return this.o.folder;
  }

  private ts() {
    return Math.floor(this.o.now().getTime() / 1000);
  }

  /** `<folder>/<object key without extension>`, e.g. fos/selfie/<userId>/<sha256>. */
  publicIdFor(key: string): string {
    return `${this.o.folder}/${key.replace(/\.[a-z0-9]+$/i, '')}`;
  }

  /** `timeoutMs`: give up after this long (a phone is waiting on the upload, ADR-053); the caller falls back. */
  async upload(body: Uint8Array, contentType: string, publicId: string, timeoutMs?: number): Promise<CloudUpload> {
    const params = { public_id: publicId, timestamp: this.ts(), type: 'authenticated', overwrite: 'true' };
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) form.append(k, String(v));
    form.append('api_key', this.o.apiKey);
    form.append('signature', signParams(params, this.o.apiSecret));
    form.append('file', new Blob([Buffer.from(body)], { type: contentType }), 'photo');
    const res = await this.fetch(`${API}/${this.o.cloudName}/image/upload`, { method: 'POST', body: form, ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}) });
    if (!res.ok) throw new CloudinaryError('upload', res.status, await errorText(res));
    const b = (await res.json()) as { public_id?: string; version?: number; bytes?: number; format?: string };
    if (!b.public_id) throw new CloudinaryError('upload', res.status, 'no public_id in the answer');
    return { publicId: b.public_id, version: Number(b.version ?? 0), bytes: Number(b.bytes ?? body.byteLength), format: b.format ?? 'jpg' };
  }

  /** Signed private download link, valid for 5 minutes (CLAUDE.md §3). */
  downloadUrl(publicId: string, format: string): { url: string; expiresAt: Date } {
    const timestamp = this.ts();
    const expires_at = timestamp + URL_TTL_SEC;
    const params = { public_id: publicId, format, type: 'authenticated', timestamp, expires_at };
    const q = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), api_key: this.o.apiKey, signature: signParams(params, this.o.apiSecret) });
    return { url: `${API}/${this.o.cloudName}/image/download?${q.toString()}`, expiresAt: new Date(expires_at * 1000) };
  }

  /** Deletes up to 100 photos; "not found" counts as deleted, so the call can be repeated. */
  async deleteMany(publicIds: string[]): Promise<void> {
    if (!publicIds.length) return;
    if (publicIds.length > CLOUD_DELETE_CHUNK) throw new Error(`at most ${CLOUD_DELETE_CHUNK} public ids per call`);
    const q = new URLSearchParams();
    for (const id of publicIds) q.append('public_ids[]', id);
    q.append('invalidate', 'true');
    const auth = Buffer.from(`${this.o.apiKey}:${this.o.apiSecret}`).toString('base64');
    const res = await this.fetch(`${API}/${this.o.cloudName}/resources/image/authenticated?${q.toString()}`, { method: 'DELETE', headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) throw new CloudinaryError('delete', res.status, await errorText(res));
  }
}

let current: CloudinaryClient | null = null;
/** The Cloudinary client, or null when it is not configured (photos then stay in the base store). */
export function cloudinary(): CloudinaryClient | null {
  return current;
}
export function setCloudinary(c: CloudinaryClient | null): void {
  current = c;
}
export function cloudinaryFromConfig(config: Config, now: () => Date, fetch?: FetchLike): CloudinaryClient | null {
  if (!cloudinaryConfigured(config)) return null;
  return new CloudinaryClient({ cloudName: config.CLOUDINARY_CLOUD_NAME!, apiKey: config.CLOUDINARY_API_KEY!, apiSecret: config.CLOUDINARY_API_SECRET!, folder: config.CLOUDINARY_FOLDER, now, ...(fetch ? { fetch } : {}) });
}
