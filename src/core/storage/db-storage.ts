import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { URL_TTL_SEC, type ObjectStorage } from './types.js';

/**
 * Object storage inside MongoDB, for hosts without S3 (the Vercel test deployment, ADR-036). The
 * in-memory store gave each serverless instance its own files and handed out `memory://` URLs no
 * phone can PUT to, so attendance photos never uploaded and the held work-in never reached the
 * server. Same contract as S3: the client PUTs to a signed URL that expires in 5 minutes, then
 * confirms; reads are signed GET URLs (5 minutes). Files are small (media ≤ 1 MB), well inside the
 * 16 MB Mongo document limit and Vercel's 4.5 MB request limit.
 */
const COLLECTION = 'storage_objects';
const MAX_BYTES = 2 * 1024 * 1024;

interface Grant {
  /** object key */
  k: string;
  m: 'PUT' | 'GET';
  /** expiry, epoch seconds */
  e: number;
  /** PUT only: content type, size, sha256 (base64) */
  t?: string;
  n?: number;
  h?: string;
}

const b64url = (b: Buffer) => b.toString('base64url');

export class DbStorage implements ObjectStorage {
  constructor(
    private opts: {
      /** public origin of this API, e.g. https://api.example.com (no trailing slash) */
      baseUrl: string;
      /** HMAC key for the URLs; stable across instances (derived from the JWT key) */
      secret: Buffer;
      now: () => Date;
    },
  ) {}

  private sign(g: Grant): string {
    const body = b64url(Buffer.from(JSON.stringify(g)));
    const sig = b64url(createHmac('sha256', this.opts.secret).update(body).digest());
    // In the query, not the path: a signed grant is longer than Fastify's 100-character path parameters.
    return `${this.opts.baseUrl}/api/v1/storage/o?t=${body}.${sig}`;
  }

  /** The grant inside a URL token, or 403 when it is forged, for another method, or expired. */
  verify(token: string, method: Grant['m']): Grant {
    const [body, sig] = token.split('.');
    const deny = () => new AppError('FORBIDDEN', { reason: 'STORAGE_URL_INVALID' });
    if (!body || !sig) throw deny();
    const want = createHmac('sha256', this.opts.secret).update(body).digest();
    const got = Buffer.from(sig, 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw deny();
    let g: Grant;
    try {
      g = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Grant;
    } catch {
      throw deny();
    }
    if (g.m !== method || typeof g.k !== 'string' || g.e * 1000 < this.opts.now().getTime()) throw deny();
    return g;
  }

  private exp() {
    return Math.floor(this.opts.now().getTime() / 1000) + URL_TTL_SEC;
  }

  async presignPut(key: string, contentType: string, sizeBytes: number, sha256Base64: string) {
    return { url: this.sign({ k: key, m: 'PUT', e: this.exp(), t: contentType, n: sizeBytes, h: sha256Base64 }), headers: { 'Content-Type': contentType } };
  }

  async presignGet(key: string) {
    return this.sign({ k: key, m: 'GET', e: this.exp() });
  }

  async exists(key: string) {
    return !!(await db().collection(COLLECTION).findOne({ _id: key as never }, { projection: { _id: 1 } }));
  }

  async put(key: string, body: Uint8Array, contentType: string) {
    await db()
      .collection(COLLECTION)
      .updateOne({ _id: key as never }, { $set: { contentType, sizeBytes: body.byteLength, body: Buffer.from(body), storedAt: this.opts.now() } }, { upsert: true });
  }

  async get(key: string): Promise<{ body: Buffer; contentType: string } | null> {
    const doc = await db().collection(COLLECTION).findOne({ _id: key as never });
    if (!doc) return null;
    const raw = doc.body as { buffer?: ArrayBufferLike } | Buffer;
    const body = Buffer.isBuffer(raw) ? raw : Buffer.from((raw as { buffer: ArrayBufferLike }).buffer);
    return { body, contentType: doc.contentType as string };
  }
}

/** HMAC key for storage URLs: the same on every instance that shares the JWT key. */
export function storageSecret(jwtPrivateKey: string | undefined): Buffer {
  return createHash('sha256').update(`fos-storage-url\n${jwtPrivateKey ?? 'dev-only'}`).digest();
}

const tokenOf = (q: unknown) => {
  const t = (q as { t?: unknown } | null)?.t;
  return typeof t === 'string' && t.length <= 4096 ? t : '';
};

/** PUT / GET targets of the signed URLs. Public: the signature in the path is the permission. */
export function storageRoutes(store: DbStorage): FastifyPluginAsync {
  return async (app) => {
    app.addContentTypeParser(/^(image|audio)\/|^application\/(octet-stream|pdf|zip|vnd\.)|^text\/csv/, { parseAs: 'buffer', bodyLimit: MAX_BYTES }, (_req, body, done) => done(null, body));
    app.put('/storage/o', { bodyLimit: MAX_BYTES }, async (req, reply) => {
      const g = store.verify(tokenOf(req.query), 'PUT');
      const body = Buffer.isBuffer(req.body) ? req.body : null;
      const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim();
      const bad = (message: string) => new AppError('VALIDATION_FAILED', { fields: [{ path: 'body', message }] });
      if (!body?.length) throw bad('empty body');
      if (g.t && type !== g.t) throw bad('content type differs from the signed one');
      if (g.n !== undefined && body.length !== g.n) throw bad('size differs from the signed one');
      if (g.h && createHash('sha256').update(body).digest('base64') !== g.h) throw bad('sha256 differs from the signed one');
      await store.put(g.k, body, type);
      reply.code(200);
      return { stored: true };
    });
    app.get('/storage/o', async (req, reply) => {
      const g = store.verify(tokenOf(req.query), 'GET');
      const obj = await store.get(g.k);
      if (!obj) throw new AppError('NOT_FOUND', { entity: 'object' });
      reply.header('Content-Type', obj.contentType).header('Cache-Control', 'private, max-age=300').header('Cross-Origin-Resource-Policy', 'cross-origin');
      return reply.send(obj.body);
    });
  };
}
