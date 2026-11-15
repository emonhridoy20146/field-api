import { validateCron } from '../jobs/cron.js';
import type { ModuleManifest } from './types.js';

/** Boot-time manifest validation (04-architecture §4). Throws with every problem listed. */
export function validateManifests(manifests: ModuleManifest[]): void {
  const problems: string[] = [];
  const names = new Set<string>();
  const permOwner = new Map<string, string>();
  const settingOwner = new Map<string, string>();
  for (const m of manifests) {
    if (!/^[a-z][a-z0-9-]*$/.test(m.name)) problems.push(`${m.name}: name must be kebab-case`);
    if (names.has(m.name)) problems.push(`${m.name}: duplicate module name`);
    names.add(m.name);
    if (m.featureFlag) {
      if (m.featureFlag.default !== false) problems.push(`${m.name}: feature flag default must be false`);
      if (!m.featureFlag.key.startsWith('module.')) problems.push(`${m.name}: flag key must start with module.`);
    } else if (!m.core) {
      problems.push(`${m.name}: non-core module needs a feature flag`);
    }
    for (const p of m.permissions) {
      const prev = permOwner.get(p.key);
      if (prev) problems.push(`permission ${p.key} declared by ${prev} and ${m.name}`);
      permOwner.set(p.key, m.name);
      if (!/^[a-z]+(\.[a-z_]+)+$/.test(p.key)) problems.push(`permission ${p.key}: invalid key format`);
    }
    for (const s of m.settings ?? []) {
      const prev = settingOwner.get(s.key);
      if (prev) problems.push(`setting ${s.key} declared by ${prev} and ${m.name}`);
      settingOwner.set(s.key, m.name);
    }
    for (const j of m.jobs ?? []) if (!validateCron(j.schedule)) problems.push(`${m.name}: job ${j.name} has invalid cron`);
  }
  for (const m of manifests)
    for (const d of m.dependsOn) if (!names.has(d)) problems.push(`${m.name}: dependsOn unknown module ${d}`);

  // Acyclic dependsOn
  const graph = new Map(manifests.map((m) => [m.name, m.dependsOn]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (n: string, path: string[]) => {
    if (state.get(n) === 'done') return;
    if (state.get(n) === 'visiting') {
      problems.push(`dependency cycle: ${[...path, n].join(' -> ')}`);
      return;
    }
    state.set(n, 'visiting');
    for (const d of graph.get(n) ?? []) visit(d, [...path, n]);
    state.set(n, 'done');
  };
  for (const m of manifests) visit(m.name, []);

  if (problems.length) throw new Error(`Invalid module manifests:\n - ${problems.join('\n - ')}`);
}

/** Order manifests so dependencies come first (stable). */
export function topoSort(manifests: ModuleManifest[]): ModuleManifest[] {
  const byName = new Map(manifests.map((m) => [m.name, m]));
  const out: ModuleManifest[] = [];
  const seen = new Set<string>();
  const visit = (m: ModuleManifest) => {
    if (seen.has(m.name)) return;
    seen.add(m.name);
    for (const d of m.dependsOn) visit(byName.get(d)!);
    out.push(m);
  };
  manifests.forEach(visit);
  return out;
}
