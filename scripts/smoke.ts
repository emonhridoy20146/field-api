/**
 * `pnpm smoke`: boots the real entrypoints against a throwaway in-memory MongoDB replica set:
 * migrate → seed → API process → health, login, a scoped read → worker boot. No external services.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
const port = 4300 + Math.floor(Math.random() * 500);
const password = `Smoke-${randomBytes(9).toString('base64url')}-1a`;
const env = {
  ...process.env,
  NODE_ENV: 'development',
  MONGODB_URI: mongo.getUri(),
  MONGODB_DB_NAME: 'smoke',
  PORT: String(port),
  ERP_MODE: 'mock',
  LOG_LEVEL: 'warn',
  SEED_PASSWORD: password,
};
const tsx = ['--import', 'tsx'];
let failed = false;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
};

/** Runs a script to completion without blocking this process (the in-memory mongod pipes its logs through us). */
function run(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...tsx, script], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (b: Buffer) => (err += b.toString()));
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${script} exited ${code}: ${err.slice(-400)}`)),
    );
  });
}

try {
  await run('scripts/migrate.ts');
  check('migrations', true);
  await run('scripts/seed-dev.ts');
  check('seed', true);

  const api = spawn(process.execPath, [...tsx, 'src/main.ts'], { env, stdio: 'inherit' });
  const base = `http://127.0.0.1:${port}/api/v1`;
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 500));
    up = await fetch(`${base}/system/health`).then(
      (r) => r.ok,
      () => false,
    );
  }
  check('API answers /system/health', up);
  if (up) {
    const headers = {
      'content-type': 'application/json',
      'x-device-id': 'smoke-device',
      'x-client': 'staff-app/1.0.0 (android 10; smoke)',
    };
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ phone: '01700000003', password, client: 'app' }),
    });
    const session = (await login.json()) as { accessToken?: string; user?: { mustChangePassword?: boolean } };
    check('field staff can sign in', login.status === 200 && !!session.accessToken, `HTTP ${login.status}`);
    check('seeded users must change their password', session.user?.mustChangePassword === true);
    const anon = await fetch(`${base}/customers`);
    check('protected route refuses anonymous calls', anon.status === 401, `HTTP ${anon.status}`);
  }
  api.kill('SIGTERM');

  const worker = spawn(process.execPath, [...tsx, 'src/main.ts'], {
    env: { ...env, PROCESS_ROLE: 'worker', LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const started = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 30_000);
    worker.stdout.on('data', (b: Buffer) => {
      if (b.toString().includes('worker started')) {
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
  check('worker starts its jobs', started);
  worker.kill('SIGTERM');
} catch (e) {
  check('smoke run', false, e instanceof Error ? e.message.slice(0, 400) : String(e));
} finally {
  await mongo.stop();
}
process.exit(failed ? 1 : 0);
