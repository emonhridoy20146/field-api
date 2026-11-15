/**
 * `pnpm seed:dev`: local development data only. Refuses to run in production.
 * Creates branches (from the mock ERP fixtures), one user per role, pulls the sample customers,
 * assigns some of them and turns every module flag ON except microfinance.
 * The password comes from SEED_PASSWORD (never committed); it must be changed at first login.
 */
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/core/config/index.js';
import { connectMongo, disconnectMongo } from '../src/core/db/index.js';
import { bootModules } from '../src/app/build-app.js';
import { MockErpClient, deltaSync, erpClient, syncBranches } from '../src/modules/erp-gateway/index.js';
import { listBranches } from '../src/modules/branches/index.js';
import { createSystemUser, findForLogin } from '../src/modules/users/index.js';
import { setFlagSystem } from '../src/modules/flags/index.js';
import { applyAssignments, getByErpId } from '../src/modules/customers/index.js';

const config = loadConfig();
if (config.NODE_ENV === 'production') throw new Error('seed:dev must never run in production');
const password = process.env.SEED_PASSWORD;
if (!password || password.length < 10)
  throw new Error('Set SEED_PASSWORD (at least 10 characters) in your shell or .env');

const fixture = (name: string) =>
  (JSON.parse(readFileSync(new URL(`../test/fixtures/erp/v1/${name}`, import.meta.url), 'utf8')) as { data: unknown[] })
    .data;

await connectMongo(config.MONGODB_URI, config.MONGODB_DB_NAME);
try {
  const ctx = await bootModules({ config, migrate: true });
  const erp = erpClient();
  // In mock mode the in-process ERP starts empty; with ERP_MODE=live (pointing at mock-erp) data comes over HTTP.
  if (erp instanceof MockErpClient)
    erp.seedLaravel({ branches: fixture('branches.ok.json'), customers: fixture('customers.ok.json') });
  await syncBranches();
  const branches = await listBranches();
  const a = branches[0]?.id;
  const b = branches[1]?.id ?? a;
  if (!a || !b) throw new Error('no branches came from the ERP');

  const users: [
    role: 'super_admin' | 'branch_manager' | 'field_staff' | 'viewer',
    phone: string,
    code: string,
    branchIds: string[],
    name: string,
  ][] = [
    ['super_admin', '01700000001', 'SA001', [a, b], 'Owner'],
    ['branch_manager', '01700000002', 'BM001', [a], 'Manager A'],
    ['field_staff', '01700000003', 'FS014', [a], 'Rakib Hasan'],
    ['field_staff', '01700000004', 'FS015', [a], 'Sumon Mia'],
    ['field_staff', '01700000005', 'FS101', [b], 'Babul B'],
    ['viewer', '01700000006', 'VW001', [a], 'Auditor'],
  ];
  const idOf = new Map<string, string>();
  for (const [role, phone, employeeCode, branchIds, name] of users) {
    const existing = await findForLogin({ phone });
    const u =
      existing ??
      (await createSystemUser({
        name: { en: name, bn: name },
        phone,
        role,
        branchIds,
        employeeCode,
        password,
        mustChangePassword: true,
      }));
    idOf.set(employeeCode, (u as { id: string }).id);
  }
  for (const m of ctx.manifests)
    if (m.featureFlag && m.name !== 'microfinance') await setFlagSystem(m.featureFlag.key, true);
  await deltaSync();
  const assign: { customerId: string; assigneeId: string }[] = [];
  for (const [erpId, code] of [
    ['100245', 'FS014'],
    ['100246', 'FS014'],
    ['100248', 'FS015'],
  ] as const) {
    const c = await getByErpId(erpId);
    if (c && idOf.get(code)) assign.push({ customerId: c.id, assigneeId: idOf.get(code)! });
  }
  if (assign.length) await applyAssignments(assign);
  console.log(
    `seeded ${branches.length} branches, ${users.length} users, ${assign.length} assignments; module flags ON (microfinance stays locked)`,
  );
  console.log(
    'Sign in with phone 01700000001 … 01700000006 and SEED_PASSWORD; each user must change it on first login.',
  );
} finally {
  await disconnectMongo();
}
