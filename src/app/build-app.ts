import { gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { v7 as uuidv7 } from 'uuid';
import type { Config } from '../core/config/index.js';
import { setContext, type AppContext } from '../core/context/index.js';
import { AppError, toProblem } from '../core/errors/index.js';
import { EventBus } from '../core/events/bus.js';
import { createLogger, type Logger } from '../core/logger/index.js';
import { initJwtKeys, verifyAccessToken } from '../core/security/jwt.js';
import { setStorage, storage, storageFromConfig } from '../core/storage/index.js';
import { DbStorage, storageRoutes } from '../core/storage/db-storage.js';
import { systemClock, type Clock } from '../core/time/index.js';
import { compareVersions, parseClientHeader } from '../core/http/index.js';
import { topoSort, validateManifests } from '../core/module/validate.js';
import { runMigrations } from '../core/db/migrations.js';
import type { ModuleManifest } from '../core/module/types.js';
import { manifests as allManifests } from './register-modules.js';

export interface BuildOptions {
  config: Config;
  clock?: Clock;
  logger?: Logger;
  manifests?: ModuleManifest[];
  migrate?: boolean;
}

export interface Built {
  app: FastifyInstance;
  ctx: AppContext;
}

/** Shared boot for api and worker: context, keys, manifests, init hooks, optional migrations. */
export async function bootModules(opts: BuildOptions): Promise<AppContext> {
  const logger = opts.logger ?? createLogger(opts.config.LOG_LEVEL);
  const manifests = topoSort(opts.manifests ?? allManifests);
  validateManifests(manifests);
  const ctx: AppContext = { config: opts.config, clock: opts.clock ?? systemClock, logger, bus: new EventBus(logger), ports: {}, manifests };
  setContext(ctx);
  await initJwtKeys(opts.config);
  setStorage(storageFromConfig(opts.config, () => ctx.clock.now()));
  for (const m of manifests) await m.init?.();
  if (opts.migrate) await runMigrations(manifests.map((m) => ({ module: m.name, migrations: m.migrations ?? [] })), (msg) => logger.info(msg));
  return ctx;
}

// Storage URLs are file transfers, not API calls: an old app must still finish its uploads.
const NO_VERSION_GATE = /^\/api\/v1\/(meta\/|system\/health|storage\/)/;

export async function buildApp(opts: BuildOptions): Promise<Built> {
  const ctx = await bootModules(opts);
  const app: FastifyInstance = Fastify({
    loggerInstance: ctx.logger as unknown as FastifyBaseLogger,
    genReqId: (req) => {
      const h = req.headers['x-request-id'];
      return typeof h === 'string' && /^[\w-]{8,64}$/.test(h) ? h : uuidv7();
    },
    trustProxy: opts.config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
  });

  app.decorateRequest('user', null);
  app.decorateRequest('authError', null);
  app.decorateRequest('perms', null);

  // admin-web is served from its own origin. @fastify/cors allows only GET, HEAD
  // and POST by default, so list every method the routes use, or the browser's
  // preflight blocks PATCH/PUT/DELETE (e.g. saving settings). Request headers are
  // reflected (default); X-Request-Id is exposed for the error banner.
  await app.register(cors, {
    origin: opts.config.ADMIN_WEB_ORIGIN.split(','),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposedHeaders: ['X-Request-Id', 'X-Server-Time', 'Retry-After'],
    maxAge: 600,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.user?.id ?? req.ip,
    errorResponseBuilder: (_req, ctxRl) => new AppError('RATE_LIMITED', { retryAfterSec: Math.ceil(ctxRl.ttl / 1000) }),
  });

  // gzip request bodies (required for /location/points, NFR mobile bandwidth).
  app.addHook('preParsing', async (req, _reply, payload) => {
    if (req.headers['content-encoding'] !== 'gzip') return payload;
    const chunks: Buffer[] = [];
    for await (const c of payload) chunks.push(c as Buffer);
    let out: Buffer;
    try {
      out = gunzipSync(Buffer.concat(chunks), { maxOutputLength: 5 * 1024 * 1024 });
    } catch {
      throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'body', message: 'Invalid gzip body' }] });
    }
    delete req.headers['content-encoding'];
    req.headers['content-length'] = String(out.length);
    return Readable.from(out);
  });

  // Authentication: decode token if present; enforcement happens per route (router.guard).
  app.addHook('onRequest', async (req) => {
    req.headers['x-request-id'] = String(req.id);
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ')) {
      try {
        const claims = await verifyAccessToken(h.slice(7), ctx.clock.now());
        const user = await ctx.ports.loadAuthUser?.(claims);
        if (user) req.user = user;
        else req.authError = new AppError('UNAUTHENTICATED');
      } catch (e) {
        req.authError = e instanceof AppError ? e : new AppError('UNAUTHENTICATED');
      }
    }
    // FR-AUTH-009 version gate for the staff app.
    const client = parseClientHeader(req.headers['x-client'] as string | undefined);
    if (client?.app === 'staff-app' && !NO_VERSION_GATE.test(req.url) && ctx.ports.minAppVersion) {
      const min = await ctx.ports.minAppVersion();
      if (compareVersions(client.version, min) < 0) throw new AppError('UPGRADE_REQUIRED', { minVersion: min });
    }
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Request-Id', String(req.id));
    reply.header('X-Server-Time', ctx.clock.now().toISOString());
  });

  app.setErrorHandler((err, req, reply) => {
    const lang = String(req.headers['accept-language'] ?? 'bn').startsWith('en') ? 'en' : 'bn';
    let e: AppError;
    if (err instanceof AppError) e = err;
    else if ((err as { statusCode?: number }).statusCode === 413 || (err as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE') e = new AppError('PAYLOAD_TOO_LARGE');
    else if ((err as { code?: string }).code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || (err as { code?: string }).code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || err instanceof SyntaxError || (err as { statusCode?: number }).statusCode === 400)
      e = new AppError('VALIDATION_FAILED', { fields: [{ path: 'body', message: (err as Error).message }] });
    else if ((err as { statusCode?: number }).statusCode === 429) e = new AppError('RATE_LIMITED');
    else {
      req.log.error({ err }, 'unhandled error');
      e = new AppError('INTERNAL');
    }
    if (e.code === 'RATE_LIMITED' && e.details?.retryAfterSec) reply.header('Retry-After', String(e.details.retryAfterSec));
    reply.status(e.status).type('application/problem+json').send(toProblem(e, lang, String(req.id)));
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).type('application/problem+json').send(toProblem(new AppError('NOT_FOUND'), 'en', String(req.id)));
  });

  await app.register(
    async (api) => {
      for (const m of ctx.manifests) {
        if (!m.routes) continue;
        await api.register(m.routes, { moduleName: m.name, ...(m.featureFlag && !m.core ? { featureFlag: m.featureFlag.key } : {}) });
      }
    },
    { prefix: '/api/v1' },
  );
  // Signed upload/download URLs when files live in the database (ADR-036).
  const store = storage();
  if (store instanceof DbStorage) await app.register(storageRoutes(store), { prefix: '/api/v1' });

  return { app, ctx };
}
