import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import { ctx } from '../../core/context/index.js';
import { defineRoutes, hasPermission, requestMeta, requireUser } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import { AppError } from '../../core/errors/index.js';
import { getUser } from '../users/index.js';
import * as s from './service.js';

const COOKIE = 'fos_rt';

function setRefreshCookie(reply: FastifyReply, token: string, expiresAt: string) {
  const cfg = ctx().config;
  reply.setCookie(COOKIE, token, {
    httpOnly: true,
    secure: cfg.NODE_ENV !== 'development' && cfg.NODE_ENV !== 'test',
    sameSite: 'strict',
    path: '/api/v1/auth',
    expires: new Date(expiresAt),
    ...(cfg.COOKIE_DOMAIN ? { domain: cfg.COOKIE_DOMAIN } : {}),
  });
}

function deviceInfoFromHeaders(h: Record<string, unknown>): s.DeviceInfo {
  // X-Client: staff-app/1.4.2 (android 10; Redmi 9A)
  const x = String(h['x-client'] ?? '');
  const m = /^[^/]+\/(\S+)\s*\(([^;)]*);?\s*([^)]*)\)?/.exec(x);
  return { appVersion: m?.[1] ?? null, androidVersion: m?.[2]?.trim() ?? null, model: m?.[3]?.trim() ?? null, manufacturer: null };
}

const loginBody = z
  .object({ phone: z.string().optional(), username: z.string().optional(), password: z.string().min(1).max(200), client: z.enum(['app', 'web']) })
  .refine((b) => b.phone || b.username, { message: 'phone or username required', path: ['phone'] });

export const authRoutes = defineRoutes((r) => {
  r.post('/auth/login', { access: 'public' }, async (req, reply) => {
    const body = parse(loginBody, req.body);
    const out = await s.login({ ...body, cookieToken: req.cookies?.[COOKIE] }, requestMeta(req), deviceInfoFromHeaders(req.headers));
    if (body.client === 'web') {
      setRefreshCookie(reply, out.refreshToken, out.refreshTokenExpiresAt);
      const { refreshToken: _rt, ...rest } = out;
      void _rt;
      return rest;
    }
    return out;
  });
  r.post('/auth/refresh', { access: 'public' }, async (req, reply) => {
    const body = parse(z.object({ refreshToken: z.string().optional() }), req.body ?? {});
    const cookieToken = req.cookies?.[COOKIE];
    const out = await s.refresh(body.refreshToken ?? cookieToken, requestMeta(req));
    if (!body.refreshToken && cookieToken) {
      setRefreshCookie(reply, out.refreshToken, out.refreshTokenExpiresAt);
      const { refreshToken: _rt, ...rest } = out;
      void _rt;
      return rest;
    }
    return out;
  });
  r.post('/auth/logout', { access: 'self', allowPasswordChangeRequired: true }, async (req, reply) => {
    await s.logout(requireUser(req), requestMeta(req));
    reply.clearCookie(COOKIE, { path: '/api/v1/auth' });
    reply.code(204);
  });
  r.post('/auth/password/change', { access: 'self', allowPasswordChangeRequired: true }, async (req, reply) => {
    const b = parse(z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(200) }), req.body);
    await s.changePassword(requireUser(req), b.currentPassword, b.newPassword, requestMeta(req));
    reply.code(204);
  });
  r.get('/auth/me', { access: 'self', allowPasswordChangeRequired: true }, async (req) => s.me(requireUser(req)));
  r.get('/auth/sessions', { access: 'self' }, async (req) => {
    const user = requireUser(req);
    const q = parse(z.object({ userId: z.string().optional() }), req.query);
    if (q.userId && q.userId !== user.id) {
      if (!(await hasPermission(req, 'device.manage'))) throw new AppError('FORBIDDEN', { permission: 'device.manage' });
      const target = await getUser(q.userId);
      if (!target || (user.role !== 'super_admin' && !target.branchIds.some((b) => user.branchIds.includes(b)))) return [];
      return s.listSessions(q.userId, user.sessionId);
    }
    return s.listSessions(user.id, user.sessionId);
  });
  r.delete('/auth/sessions/:id', { access: 'self' }, async (req, reply) => {
    const user = requireUser(req);
    await s.revokeSession(user, (req.params as { id: string }).id, await hasPermission(req, 'device.manage'), requestMeta(req));
    reply.code(204);
  });
});
