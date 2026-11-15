import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { expect } from 'vitest';

type Json = Record<string, unknown>;
const doc = parse(readFileSync(fileURLToPath(new URL('../../docs/openapi.yaml', import.meta.url)), 'utf8')) as Json;

const rewrite = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(rewrite);
  if (v && typeof v === 'object') {
    const out: Json = {};
    for (const [k, x] of Object.entries(v as Json)) out[k] = k === '$ref' && typeof x === 'string' ? x.replace(/^#\//, 'oas#/') : rewrite(x);
    return out;
  }
  return v;
};

const ajv = new Ajv2020({ strict: false, allErrors: true });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
ajv.addSchema({ $id: 'oas', components: rewrite(doc.components) as Json });

const paths = doc.paths as Record<string, Record<string, Json>>;
const templates = Object.keys(paths).map((p) => ({ p, rx: new RegExp(`^${p.replace(/\{[^}]+\}/g, '[^/]+')}$`) }));

/** Validates a response body against docs/openapi.yaml (07-test-plan: conformance). */
export function expectConforms(method: string, url: string, status: number, body: unknown): void {
  const path = url.replace(/^\/api\/v1/, '').split('?')[0]!;
  const tpl = templates.find((t) => t.rx.test(path) && paths[t.p]?.[method.toLowerCase()]);
  expect(tpl, `no openapi path for ${method} ${path}`).toBeTruthy();
  const op = paths[tpl!.p]![method.toLowerCase()] as Json;
  const responses = op.responses as Record<string, Json>;
  const resp = responses[String(status)] ?? responses.default;
  expect(resp, `status ${status} not documented for ${method} ${tpl!.p}`).toBeTruthy();
  let r = resp as Json;
  if (typeof r.$ref === 'string') r = (doc.components as Json & { responses: Record<string, Json> }).responses[(r.$ref as string).split('/').pop()!]!;
  const content = r.content as Record<string, { schema?: Json }> | undefined;
  const schema = content?.['application/json']?.schema ?? content?.['application/problem+json']?.schema;
  if (!schema) return; // documented without a body schema
  const validate = ajv.compile(rewrite(schema) as Json);
  const ok = validate(body);
  expect(ok, `${method} ${tpl!.p} ${status} does not conform: ${ajv.errorsText(validate.errors)}`).toBe(true);
}
