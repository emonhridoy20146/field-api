import { createHash } from 'node:crypto';
import type { Db } from 'mongodb';
import { db } from './index.js';

/** Forward-only, idempotent migration (06-data-model §8). */
export interface Migration {
  id: string; // e.g. '20261115-0001-create-users-indexes'
  up(db: Db): Promise<void>;
}

export interface ModuleMigrations {
  module: string;
  migrations: Migration[];
}

export async function runMigrations(sets: ModuleMigrations[], log: (m: string) => void = () => {}): Promise<string[]> {
  const d = db();
  const changelog = d.collection('migrations_changelog');
  await changelog.createIndex({ module: 1, id: 1 }, { unique: true });
  const applied: string[] = [];
  for (const set of sets) {
    for (const m of [...set.migrations].sort((a, b) => a.id.localeCompare(b.id))) {
      const exists = await changelog.findOne({ module: set.module, id: m.id });
      if (exists) continue;
      const started = Date.now();
      await m.up(d);
      await changelog.insertOne({
        module: set.module,
        id: m.id,
        appliedAt: new Date(),
        durationMs: Date.now() - started,
        checksum: createHash('sha256').update(m.up.toString()).digest('hex').slice(0, 16),
      });
      applied.push(`${set.module}/${m.id}`);
      log(`migration applied ${set.module}/${m.id}`);
    }
  }
  return applied;
}

/** Helper for the common case: a migration that only creates indexes. */
export function indexMigration(
  id: string,
  specs: { collection: string; key: Record<string, 1 | -1 | '2dsphere' | 'text'>; options?: Record<string, unknown> }[],
): Migration {
  return {
    id,
    async up(d) {
      for (const s of specs) await d.collection(s.collection).createIndex(s.key, s.options ?? {});
    },
  };
}
