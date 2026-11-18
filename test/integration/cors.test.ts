import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app.js';

// admin-web runs on its own origin (ADMIN_WEB_ORIGIN, e.g. the Vercel test
// deploy), so every method it sends must pass the browser's CORS preflight.
// @fastify/cors only allows GET, HEAD and POST unless told otherwise, which
// blocked saving settings (PATCH /settings) from the admin panel.
let t: TestApp;
const ORIGIN = 'http://localhost:3000'; // config default ADMIN_WEB_ORIGIN
const ADMIN_HEADERS = 'authorization,content-type,idempotency-key,x-client,x-requested-with,accept-language';

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());

const preflight = (url: string, method: string, origin = ORIGIN) =>
  t.app.inject({
    method: 'OPTIONS',
    url,
    headers: { origin, 'access-control-request-method': method, 'access-control-request-headers': ADMIN_HEADERS },
  });

describe('CORS for the admin panel', () => {
  for (const [method, url] of [
    ['PATCH', '/api/v1/settings'],
    ['PUT', '/api/v1/targets/branch'],
    ['DELETE', '/api/v1/holidays/h-1'],
    ['POST', '/api/v1/auth/login'],
    ['GET', '/api/v1/customers'],
  ] as const) {
    it(`preflight allows ${method} with credentials and the admin headers`, async () => {
      const res = await preflight(url, method);
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      const methods = String(res.headers['access-control-allow-methods']).split(/,\s*/);
      expect(methods).toContain(method);
      const headers = String(res.headers['access-control-allow-headers']).toLowerCase().split(/,\s*/);
      for (const h of ADMIN_HEADERS.split(',')) expect(headers).toContain(h);
    });
  }

  it('gives no CORS grant to another origin', async () => {
    const res = await preflight('/api/v1/settings', 'PATCH', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('lets the admin panel read the request id of an answer', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/system/health', headers: { origin: ORIGIN } });
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(String(res.headers['access-control-expose-headers']).toLowerCase()).toContain('x-request-id');
  });
});
