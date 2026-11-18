import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, createTestApp, type TestApp } from '../helpers/app.js';
import { createFirstAdmin } from '../../src/app/go-live.js';
import { isEnabled } from '../../src/modules/flags/index.js';
import { listBranches } from '../../src/modules/branches/index.js';

// Production first run: `node dist/src/cli.js create-admin` (no seed data in production).
let t: TestApp;
const PW = 'Owner-Start-2026';

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());

describe('go live: first super admin', () => {
  it('refuses a weak password before touching anything', async () => {
    await expect(createFirstAdmin(t.ctx, { phone: '01711000001', name: 'Owner', password: 'short' })).rejects.toMatchObject({
      code: 'BUSINESS_RULE',
    });
    expect(await listBranches()).toHaveLength(0);
  });

  it('pulls the ERP branches, creates the admin on all of them and can switch the modules on', async () => {
    const r = await createFirstAdmin(t.ctx, { phone: '01711000001', name: 'Owner', password: PW, enableModules: true });
    const branches = await listBranches();
    expect(r.branches).toBe(branches.length);
    expect(branches.length).toBeGreaterThan(0);
    expect(r.user.role).toBe('super_admin');
    expect([...r.user.branchIds].sort()).toEqual(branches.map((b) => b.id).sort());
    expect(r.modulesOn).toContain('module.customers');
    expect(r.modulesOn.some((k) => k.includes('microfinance'))).toBe(false);
    expect(await isEnabled('module.customers')).toBe(true);

    // The admin can sign in to the web panel and is asked to change the password.
    const res = await client(t.app).post('/auth/login', { phone: '01711000001', password: PW, client: 'web' });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('super_admin');
    expect(res.body.user.mustChangePassword).toBe(true);
  });

  it('never makes a second account for the same phone', async () => {
    await expect(createFirstAdmin(t.ctx, { phone: '+8801711000001', name: 'Owner', password: PW })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });
});
