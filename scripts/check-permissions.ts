/**
 * `pnpm check:permissions` (CLAUDE.md §2.6, 02-requirements §3.1):
 *  - every route declares its access, and every permission it names is declared by a manifest;
 *  - a key is declared in exactly one manifest (validateManifests);
 *  - the code catalog and the table in docs/02-requirements.md §3.1 agree on keys, owner module and role defaults.
 * Keys of modules that are not built yet may exist only in the docs; that is reported, not failed.
 */
import { readFileSync } from 'node:fs';
import { collectRoutes, manifests } from './lib/routes.js';

const ROLES = ['super_admin', 'area_manager', 'branch_manager', 'field_staff', 'viewer'] as const;
const errors: string[] = [];
const notes: string[] = [];

const declared = new Map<
  string,
  { module: string; defaults: Record<string, boolean | undefined>; reserved: boolean; neverFor: string[] }
>();
for (const m of manifests)
  for (const p of m.permissions)
    declared.set(p.key, { module: m.name, defaults: p.defaults, reserved: !!p.reserved, neverFor: p.neverFor ?? [] });

const routes = await collectRoutes();
const used = new Set<string>();
for (const r of routes) {
  const keys = typeof r.access === 'object' ? ('permission' in r.access ? [r.access.permission] : r.access.anyOf) : [];
  for (const k of keys) {
    used.add(k);
    if (!declared.has(k)) errors.push(`${r.method} ${r.path} (${r.module}) requires undeclared permission ${k}`);
  }
}

// docs table rows: | `key` **[ADDED]** | description | SA | AM | BM | FS | VW | module | (AM since 1.48.0; — = never, `neverFor`)
const doc = readFileSync(new URL('../docs/02-requirements.md', import.meta.url), 'utf8');
const documented = new Map<string, { marks: string[]; module: string }>();
for (const line of doc.split('\n')) {
  const m =
    /^\|\s*`([a-z_.]+)`[^|]*\|[^|]*\|\s*([●○—])\s*\|\s*([●○—])\s*\|\s*([●○—])\s*\|\s*([●○—])\s*\|\s*([●○—])\s*\|\s*([a-z-]+)\s*\|/.exec(
      line,
    );
  if (m) documented.set(m[1]!, { marks: [m[2]!, m[3]!, m[4]!, m[5]!, m[6]!], module: m[7]! });
}
if (documented.size < 20) errors.push('could not read the permission catalog from docs/02-requirements.md §3.1');

const builtModules = new Set(manifests.map((m) => m.name));
for (const [key, d] of declared) {
  const row = documented.get(key);
  if (!row) {
    errors.push(`permission ${key} (${d.module}) is missing from docs/02-requirements.md §3.1`);
    continue;
  }
  if (row.module !== d.module)
    errors.push(`permission ${key}: docs say module ${row.module}, code declares it in ${d.module}`);
  if (d.reserved) continue;
  ROLES.forEach((role, i) => {
    const inDocs = row.marks[i] === '●';
    if (inDocs !== !!d.defaults[role])
      errors.push(`permission ${key}: default for ${role} is ${!!d.defaults[role]} in code but ${inDocs} in docs`);
    const never = d.neverFor.includes(role);
    if (never !== (row.marks[i] === '—'))
      errors.push(
        `permission ${key}: ${role} is ${never ? '' : 'not '}in neverFor in code but marked ${row.marks[i]} in docs`,
      );
    if (never && d.defaults[role]) errors.push(`permission ${key}: ${role} is both granted by default and in neverFor`);
  });
}
for (const [key, row] of documented) {
  if (declared.has(key)) continue;
  if (builtModules.has(row.module))
    errors.push(`permission ${key} is documented for module ${row.module} but not declared in its manifest`);
  else notes.push(`${key} (module ${row.module} not built yet)`);
}
const unused = [...declared.keys()].filter((k) => !used.has(k) && !declared.get(k)!.reserved);

console.log(`routes: ${routes.length} · permissions declared: ${declared.size} · documented: ${documented.size}`);
if (unused.length) console.log(`declared but not required by any route yet: ${unused.join(', ')}`);
if (notes.length) console.log(`documented only: ${notes.join(', ')}`);
if (errors.length) {
  console.error(`\n${errors.length} problem(s):\n - ${errors.join('\n - ')}`);
  process.exit(1);
}
console.log('permissions OK');
