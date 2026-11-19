import type { FastifyRequest } from 'fastify';

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim();

/**
 * The public origin a request came in on (`https://api.example.com`), from the proxy headers when present (Vercel,
 * a rewrite from admin-web's own host) or the Host header. Only used to build links back to this API for the same
 * caller (storage URLs, ADR-039), never for security decisions. Undefined when the host looks malformed.
 */
export function requestOrigin(req: FastifyRequest): string | undefined {
  const host = first(req.headers['x-forwarded-host']) ?? first(req.headers.host);
  if (!host || !/^[a-z0-9.-]+(:\d{1,5})?$/i.test(host)) return undefined;
  const proto = first(req.headers['x-forwarded-proto']) ?? req.protocol;
  return `${proto === 'http' ? 'http' : 'https'}://${host}`;
}
