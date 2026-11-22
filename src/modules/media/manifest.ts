import type { ModuleManifest } from '../../core/module/types.js';
import { indexMigration } from '../../core/db/migrations.js';
import { registerOutboxHandler } from '../../core/events/outbox.js';
import { mediaRoutes } from './routes.js';
import { COPY_JOB, REMOTE_DELETE_JOB, copyToCloud, remoteDeleteJob } from './cloud.js';

export const manifest: ModuleManifest = {
  name: 'media',
  version: '1.0.0',
  core: true,
  description: 'Presigned uploads/downloads to private object storage with sha256 dedupe; copy to Cloudinary; admin deletion (FR-MED-001..004)',
  dependsOn: ['audit'],
  permissions: [
    { key: 'media.delete', description: { en: 'Delete photos: previous months, or one staff member\'s attendance photos of a day', bn: 'ছবি মুছে ফেলা: আগের মাসের, বা কোনো কর্মীর একদিনের হাজিরার ছবি' }, defaults: { super_admin: true } },
  ],
  routes: mediaRoutes,
  events: { emits: [], consumes: [] },
  migrations: [
    indexMigration('20261115-0001-media-indexes', [
      { collection: 'media', key: { ownerId: 1, sha256: 1, kind: 1 }, options: { unique: true } },
      { collection: 'media', key: { status: 1, createdAt: 1 } },
    ]),
    indexMigration('20261122-0001-media-purge-index', [{ collection: 'media', key: { kind: 1, status: 1, createdAt: 1 } }]),
  ],
  init: () => {
    registerOutboxHandler(COPY_JOB, copyToCloud);
    registerOutboxHandler(REMOTE_DELETE_JOB, remoteDeleteJob);
  },
};
