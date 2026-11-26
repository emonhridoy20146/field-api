import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../errors/index.js';
import { ctx } from '../context/index.js';
import type { AuthUser } from '../security/types.js';
import type { RoutePluginOptions } from '../module/types.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    authError: AppError | null;
    perms: Set<string> | null;
  }
  interface FastifyContextConfig {
    access?: Access;
    permission?: string;
    trackingAuth?: TrackingAuth;
  }
}

/**
 * - `public`: no token needed.
 * - `self`: any authenticated user (self-service, own data); still scope-checked in the service.
 * - a permission key: authenticated and `rbac` must allow it.
 */
export type Access = 'public' | 'self' | { permission: string } | { anyOf: string[] };

/** Resolves an `Authorization: Tracking <token>` value to the user, or throws an AppError (ADR-067). */
export type TrackingAuth = (token: string) => Promise<AuthUser>;

export interface RouteOpts {
  access: Access;
  /**
   * 1.49.0 (ADR-067): this route also accepts a tracking token, resolved by this function. Routes without it refuse
   * one with 401 TRACKING_TOKEN_NOT_ALLOWED. Only POST /location/points sets it.
   */
  trackingAuth?: TrackingAuth;
  /** Allowed while user must still change password (auth endpoints). */
  allowPasswordChangeRequired?: boolean;
  bodyLimit?: number;
}

export type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

export interface Router {
  get(url: string, opts: RouteOpts, h: Handler): void;
  post(url: string, opts: RouteOpts, h: Handler): void;
  put(url: string, opts: RouteOpts, h: Handler): void;
  patch(url: string, opts: RouteOpts, h: Handler): void;
  delete(url: string, opts: RouteOpts, h: Handler): void;
}

export const perm = (permission: string): Access => ({ permission });

/** The authenticated user, or 401. */
export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw req.authError ?? new AppError('UNAUTHENTICATED');
  return req.user;
}

export async function hasPermission(req: FastifyRequest, key: string): Promise<boolean> {
  const user = requireUser(req);
  if (!req.perms) req.perms = (await ctx().ports.permissions?.(user)) ?? new Set();
  return req.perms.has(key);
}

async function guard(req: FastifyRequest, opts: RouteOpts, featureFlag: string | undefined): Promise<void> {
  if (opts.access === 'public') {
    if (featureFlag && !(await ctx().ports.flagEnabled?.(featureFlag, req.user))) throw new AppError('FEATURE_DISABLED', { flag: featureFlag });
    return;
  }
  const user = requireUser(req);
  // Second line of defence behind the auth hook: a tracking-token user only reaches routes that opted in.
  if (user.via === 'tracking' && !opts.trackingAuth) throw new AppError('UNAUTHENTICATED', { reason: 'TRACKING_TOKEN_NOT_ALLOWED' });
  if (user.mustChangePassword && !opts.allowPasswordChangeRequired) throw new AppError('PASSWORD_CHANGE_REQUIRED');
  if (featureFlag && !(await ctx().ports.flagEnabled?.(featureFlag, user))) throw new AppError('FEATURE_DISABLED', { flag: featureFlag });
  if (opts.access === 'self') return;
  if ('permission' in opts.access) {
    if (!(await hasPermission(req, opts.access.permission))) throw new AppError('FORBIDDEN', { permission: opts.access.permission });
    return;
  }
  for (const k of opts.access.anyOf) if (await hasPermission(req, k)) return;
  throw new AppError('FORBIDDEN', { permission: opts.access.anyOf.join('|') });
}

/** Wraps a module's route definitions into a Fastify plugin with auth, feature gate and permission guard. */
export function defineRoutes(define: (r: Router) => void): FastifyPluginAsync<RoutePluginOptions> {
  return async (app: FastifyInstance, pluginOpts: RoutePluginOptions) => {
    const add = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE') => (url: string, opts: RouteOpts, h: Handler) => {
      if (!opts || !opts.access) throw new Error(`${method} ${url}: access must be declared`);
      app.route({
        method,
        url,
        ...(opts.bodyLimit ? { bodyLimit: opts.bodyLimit } : {}),
        config: {
          access: opts.access,
          ...(typeof opts.access === 'object' && 'permission' in opts.access ? { permission: opts.access.permission } : {}),
          ...(opts.trackingAuth ? { trackingAuth: opts.trackingAuth } : {}),
        },
        preHandler: async (req) => guard(req, opts, pluginOpts.featureFlag),
        handler: async (req, reply) => {
          const out = await h(req, reply);
          if (reply.sent) return reply;
          if (out === undefined) return reply.code(reply.statusCode === 200 ? 204 : reply.statusCode).send();
          return out;
        },
      });
    };
    define({ get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE') });
  };
}

export const clientIp = (req: FastifyRequest) => req.ip;
export const requestMeta = (req: FastifyRequest) => ({
  ip: req.ip,
  requestId: String(req.id),
  deviceId: (req.headers['x-device-id'] as string | undefined) ?? req.user?.deviceId ?? null,
  userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
});
export type RequestMeta = ReturnType<typeof requestMeta>;
