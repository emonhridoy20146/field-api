import type { ModuleManifest } from '../../core/module/types.js';
import { indexMigration } from '../../core/db/migrations.js';
import { mediaRoutes } from './routes.js';

export const manifest: ModuleManifest = {
  name: 'media',
  version: '1.0.0',
  core: true,
  description: 'Presigned uploads/downloads to private object storage with sha256 dedupe (FR-MED-001)',
  dependsOn: [],
  permissions: [],
  routes: mediaRoutes,
  events: { emits: [], consumes: [] },
  migrations: [
    indexMigration('20261115-0001-media-indexes', [
      { collection: 'media', key: { ownerId: 1, sha256: 1, kind: 1 }, options: { unique: true } },
      { collection: 'media', key: { status: 1, createdAt: 1 } },
    ]),
  ],
};
