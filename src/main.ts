import { loadConfig } from './core/config/index.js';
import { connectMongo, disconnectMongo } from './core/db/index.js';
import { bootModules, buildApp } from './app/build-app.js';
import { startWorker } from './app/worker.js';

async function main() {
  const config = loadConfig();
  await connectMongo(config.MONGODB_URI, config.MONGODB_DB_NAME);
  if (config.PROCESS_ROLE === 'worker') {
    const ctx = await bootModules({ config });
    const w = startWorker(ctx);
    const shutdown = async () => {
      w.stop();
      await disconnectMongo();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    return;
  }
  const { app } = await buildApp({ config });
  const shutdown = async () => {
    await app.close();
    await disconnectMongo();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
