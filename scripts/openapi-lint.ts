/**
 * `pnpm openapi:lint`: structural checks on docs/openapi.yaml and its agreement with the code.
 *  - parses, has info.version, unique operationIds, every $ref resolves, every operation has responses;
 *  - every implemented route exists in the contract (contract first, CLAUDE.md §4.2);
 *  - contract paths that are not implemented yet are listed (later phases), not failed.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { collectRoutes } from './lib/routes.js';

type Json = Record<string, unknown>;
const doc = parse(readFileSync(new URL('../docs/openapi.yaml', import.meta.url), 'utf8')) as Json;
const errors: string[] = [];
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

const info = doc.info as Json | undefined;
if (!/^\d+\.\d+\.\d+/.test(String(info?.version ?? ''))) errors.push('info.version must be semver');
if (!String(doc.openapi ?? '').startsWith('3.1')) errors.push('openapi must be 3.1.x');

const resolve = (ref: string): unknown => {
  if (!ref.startsWith('#/')) return undefined;
  let cur: unknown = doc;
  for (const part of ref.slice(2).split('/'))
    cur = (cur as Json | undefined)?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  return cur;
};
const walk = (v: unknown, at: string): void => {
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v as Json)) {
      if (k === '$ref' && typeof x === 'string' && resolve(x) === undefined) errors.push(`${at}: unresolved $ref ${x}`);
      walk(x, `${at}.${k}`);
    }
};
walk(doc, '#');

const paths = (doc.paths ?? {}) as Record<string, Json>;
const opIds = new Map<string, string>();
const contract = new Set<string>();
for (const [p, item] of Object.entries(paths))
  for (const method of METHODS) {
    const op = item[method] as Json | undefined;
    if (!op) continue;
    const key = `${method.toUpperCase()} ${p}`;
    contract.add(key.replace(/\{[^}]+\}/g, '{}'));
    const id = String(op.operationId ?? '');
    if (!id) errors.push(`${key}: missing operationId`);
    else if (opIds.has(id)) errors.push(`${key}: operationId ${id} already used by ${opIds.get(id)}`);
    else opIds.set(id, key);
    if (!op.responses || !Object.keys(op.responses as Json).length) errors.push(`${key}: no responses`);
    for (const name of p.match(/\{([^}]+)\}/g) ?? []) {
      const params = [...((item.parameters as Json[]) ?? []), ...((op.parameters as Json[]) ?? [])].map((x) =>
        typeof x.$ref === 'string' ? (resolve(x.$ref) as Json) : x,
      );
      if (!params.some((x) => x?.in === 'path')) errors.push(`${key}: path parameter ${name} is not declared`);
    }
  }

const routes = await collectRoutes();
const implemented = new Set(routes.map((r) => `${r.method} ${r.path}`.replace(/\{[^}]+\}/g, '{}')));
for (const r of routes)
  if (!contract.has(`${r.method} ${r.path}`.replace(/\{[^}]+\}/g, '{}')))
    errors.push(`${r.method} ${r.path} (${r.module}) is implemented but not in docs/openapi.yaml`);
const pending = [...contract].filter((c) => !implemented.has(c));

console.log(`openapi ${String(info?.version)} · ${contract.size} operations · ${implemented.size} implemented`);
if (pending.length) console.log(`in the contract, not implemented yet (${pending.length}):\n  ${pending.join('\n  ')}`);
if (errors.length) {
  console.error(`\n${errors.length} problem(s):\n - ${errors.join('\n - ')}`);
  process.exit(1);
}
console.log('openapi OK');
