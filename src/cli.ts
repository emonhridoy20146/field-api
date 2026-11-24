/**
 * Operator commands for a deployed image (no tsx, no dev scripts there):
 *   node dist/src/cli.js migrate
 *   ADMIN_PASSWORD=... node dist/src/cli.js create-admin --phone 01XXXXXXXXX --name "Owner" [--code SA001] [--enable-modules]
 * The password is read from ADMIN_PASSWORD so it never sits in the shell history; it must be changed at first login.
 */
import { parseArgs } from 'node:util';
import { loadConfig } from './core/config/index.js';
import { connectMongo, disconnectMongo, poolFrom } from './core/db/index.js';
import { bootModules } from './app/build-app.js';
import { createFirstAdmin } from './app/go-live.js';

const USAGE = `Usage:
  node dist/src/cli.js migrate
  ADMIN_PASSWORD=... node dist/src/cli.js create-admin --phone 01XXXXXXXXX --name "Owner" [--code SA001] [--enable-modules]`;

// Plain output for the operator's terminal (the app logger is JSON for log collectors).
const out = (line: string) => process.stdout.write(`${line}\n`);
const err = (line: string) => process.stderr.write(`${line}\n`);

async function run(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command !== 'migrate' && command !== 'create-admin') {
    err(USAGE);
    process.exitCode = 2;
    return;
  }
  const { values } = parseArgs({
    args: rest,
    options: { phone: { type: 'string' }, name: { type: 'string' }, code: { type: 'string' }, 'enable-modules': { type: 'boolean' } },
  });
  const password = process.env.ADMIN_PASSWORD ?? '';
  if (command === 'create-admin' && (!values.phone || !values.name || !password)) {
    err('create-admin needs --phone, --name and the ADMIN_PASSWORD environment variable.\n' + USAGE);
    process.exitCode = 2;
    return;
  }

  const config = loadConfig();
  await connectMongo(config.MONGODB_URI, config.MONGODB_DB_NAME, poolFrom(config));
  try {
    // Migrations are forward-only and idempotent, so both commands apply them first.
    const ctx = await bootModules({ config, migrate: true });
    if (command === 'migrate') {
      out('migrations applied');
      return;
    }
    const r = await createFirstAdmin(ctx, {
      phone: values.phone!,
      name: values.name!,
      password,
      ...(values.code ? { employeeCode: values.code } : {}),
      enableModules: values['enable-modules'] === true,
    });
    out(`super admin created (id ${r.user.id}) for ${r.branches} ERP branches; the password must be changed at first login`);
    if (r.modulesOn.length) out(`modules switched on: ${r.modulesOn.join(', ')}`);
  } finally {
    await disconnectMongo();
  }
}

run(process.argv.slice(2)).catch((e: unknown) => {
  const x = e as { code?: string; details?: unknown; message?: string };
  err(x.code ? `${x.code}: ${x.message ?? ''} ${JSON.stringify(x.details ?? {})}` : String((e as Error)?.stack ?? e));
  process.exit(1);
});
