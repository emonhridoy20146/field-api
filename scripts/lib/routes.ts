import Fastify from 'fastify';
import { manifests } from '../../src/app/register-modules.js';
import { validateManifests } from '../../src/core/module/validate.js';
import type { Access } from '../../src/core/http/router.js';

export interface RouteInfo {
  module: string;
  method: string;
  /** Path below /api/v1 in OpenAPI form, e.g. /customers/{id}. */
  path: string;
  access: Access;
}

/** Registers every module's routes on a throwaway Fastify instance (no database) and lists them. */
export async function collectRoutes(): Promise<RouteInfo[]> {
  validateManifests(manifests);
  const out: RouteInfo[] = [];
  for (const m of manifests) {
    if (!m.routes) continue;
    const app = Fastify();
    app.decorateRequest('user', null);
    app.addHook('onRoute', (r) => {
      const access = (r.config as { access?: Access } | undefined)?.access;
      if (!access) return;
      for (const method of Array.isArray(r.method) ? r.method : [r.method]) {
        if (method === 'HEAD') continue;
        out.push({ module: m.name, method, path: r.url.replace(/:([A-Za-z]+)/g, '{$1}'), access });
      }
    });
    await app.register(m.routes, { moduleName: m.name });
    await app.ready();
    await app.close();
  }
  return out;
}

export { manifests };
