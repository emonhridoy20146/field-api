/** `pnpm db:migrate`: run every module's forward-only, idempotent migrations, then exit. */
import { loadConfig } from '../src/core/config/index.js';
import { connectMongo, disconnectMongo } from '../src/core/db/index.js';
import { bootModules } from '../src/app/build-app.js';

const config = loadConfig();
await connectMongo(config.MONGODB_URI, config.MONGODB_DB_NAME);
try {
  await bootModules({ config, migrate: true });
  console.log('migrations applied');
} finally {
  await disconnectMongo();
}
