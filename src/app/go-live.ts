/**
 * Production first-run steps (no HTTP): apply migrations, pull the ERP's branches and create the
 * first super admin. Used by `node dist/src/cli.js` inside the image, where dev scripts and tsx are absent.
 */
import { syncBranches } from '../modules/erp-gateway/index.js';
import { listBranches } from '../modules/branches/index.js';
import { checkPasswordPolicy, createSystemUser, findForLogin, type UserView } from '../modules/users/index.js';
import { setFlagSystem } from '../modules/flags/index.js';
import { invalidState } from '../core/errors/index.js';
import type { AppContext } from '../core/context/index.js';

export interface FirstAdminInput {
  phone: string;
  name: string;
  password: string;
  employeeCode?: string;
  /** Turn every module flag on (microfinance stays off, FR-MF-001). */
  enableModules?: boolean;
}

export interface FirstAdminResult {
  user: UserView;
  branches: number;
  modulesOn: string[];
}

export async function createFirstAdmin(ctx: AppContext, input: FirstAdminInput): Promise<FirstAdminResult> {
  checkPasswordPolicy(input.password, input.phone);
  if (await findForLogin({ phone: input.phone }))
    throw invalidState('A user with this phone already exists');

  // The admin works across every branch; the branches come from the ERP, so it must answer first.
  await syncBranches();
  const branchIds = (await listBranches()).map((b) => b.id);
  if (branchIds.length === 0) throw invalidState('The ERP returned no branches');

  const user = await createSystemUser({
    name: { bn: input.name, en: input.name },
    phone: input.phone,
    role: 'super_admin',
    branchIds,
    employeeCode: input.employeeCode ?? 'SA001',
    password: input.password,
    mustChangePassword: true,
  });

  const modulesOn: string[] = [];
  if (input.enableModules)
    for (const m of ctx.manifests)
      if (m.featureFlag && m.name !== 'microfinance') {
        await setFlagSystem(m.featureFlag.key, true);
        modulesOn.push(m.featureFlag.key);
      }
  return { user, branches: branchIds.length, modulesOn };
}
