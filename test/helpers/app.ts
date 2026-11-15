import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../src/core/config/index.js';
import { connectMongo, disconnectMongo, mongoose } from '../../src/core/db/index.js';
import { buildApp } from '../../src/app/build-app.js';
import type { AppContext } from '../../src/core/context/index.js';
import { FixedClock } from '../../src/core/time/index.js';
import { MockErpClient, setErpClient, syncBranches } from '../../src/modules/erp-gateway/index.js';
import { listBranches } from '../../src/modules/branches/index.js';
import { createSystemUser, type UserView } from '../../src/modules/users/index.js';
import { setFlagSystem } from '../../src/modules/flags/index.js';

export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/erp/v1/${name}`, import.meta.url)), 'utf8'));

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  erp: MockErpClient;
  clock: FixedClock;
  close: () => Promise<void>;
}

export async function createTestApp(opts: { now?: string; seedErp?: boolean } = {}): Promise<TestApp> {
  const clock = new FixedClock(opts.now ?? '2026-11-15T04:00:00Z'); // 10:00 Dhaka
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', ERP_MODE: 'mock' });
  await connectMongo(inject('mongoUri'), `t_${randomUUID().replace(/-/g, '').slice(0, 20)}`);
  const { app, ctx } = await buildApp({ config, clock, migrate: true });
  const erp = new MockErpClient();
  if (opts.seedErp !== false) erp.seedLaravel({ branches: (fixture('branches.ok.json') as { data: unknown[] }).data, customers: (fixture('customers.ok.json') as { data: unknown[] }).data });
  setErpClient(erp);
  await app.ready();
  return {
    app,
    ctx,
    erp,
    clock,
    close: async () => {
      await app.close();
      await mongoose.connection.dropDatabase();
      await disconnectMongo();
    },
  };
}

export const PASSWORD = 'Str0ng-Test-Pass';

export interface Seeded {
  branchA: string; // BRL01
  branchB: string; // PTK01
  sa: UserView;
  bm: UserView;
  fs1: UserView;
  fs2: UserView;
  fsB: UserView;
  vw: UserView;
}

/** Branches from mock ERP + one user per role. Optionally turns every module flag ON. */
export async function seedBasics(t: TestApp, opts: { flagsOn?: boolean } = {}): Promise<Seeded> {
  await syncBranches();
  const branches = await listBranches();
  const branchA = branches.find((b) => b.code === 'BRL01')!.id;
  const branchB = branches.find((b) => b.code === 'PTK01')!.id;
  const mk = (role: UserView['role'], phone: string, code: string, branchIds: string[], en: string) =>
    createSystemUser({ name: { en, bn: en }, phone, role, branchIds, employeeCode: code, password: PASSWORD });
  const seeded: Seeded = {
    branchA,
    branchB,
    sa: await mk('super_admin', '01700000001', 'SA001', [branchA, branchB], 'Owner'),
    bm: await mk('branch_manager', '01700000002', 'BM001', [branchA], 'Manager A'),
    fs1: await mk('field_staff', '01700000003', 'FS014', [branchA], 'Rakib Hasan'),
    fs2: await mk('field_staff', '01700000004', 'FS015', [branchA], 'Sumon Mia'),
    fsB: await mk('field_staff', '01700000005', 'FS101', [branchB], 'Babul B'),
    vw: await mk('viewer', '01700000006', 'VW001', [branchA], 'Auditor'),
  };
  if (opts.flagsOn !== false) for (const m of t.ctx.manifests) if (m.featureFlag && m.name !== 'microfinance') await setFlagSystem(m.featureFlag.key, true);
  return seeded;
}

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | undefined>;
}

export function client(app: FastifyInstance, token?: string, extraHeaders: Record<string, string> = {}) {
  const call = async <T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> => {
    const res = await app.inject({
      method,
      url: url.startsWith('/api') ? url : `/api/v1${url}`,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'accept-language': 'en', ...extraHeaders, ...headers },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
    return { status: res.statusCode, body: res.body ? (res.json() as T) : (undefined as T), headers: res.headers };
  };
  return {
    get: <T = any>(url: string, h?: Record<string, string>) => call<T>('GET', url, undefined, h),
    post: <T = any>(url: string, body?: unknown, h?: Record<string, string>) => call<T>('POST', url, body ?? {}, h),
    put: <T = any>(url: string, body?: unknown, h?: Record<string, string>) => call<T>('PUT', url, body ?? {}, h),
    patch: <T = any>(url: string, body?: unknown, h?: Record<string, string>) => call<T>('PATCH', url, body ?? {}, h),
    delete: <T = any>(url: string, h?: Record<string, string>) => call<T>('DELETE', url, undefined, h),
  };
}

export async function login(app: FastifyInstance, phone: string, opts: { client?: 'app' | 'web'; deviceId?: string; password?: string } = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-device-id': opts.deviceId ?? `dev-${phone}`, 'x-client': 'staff-app/1.0.0 (android 10; Redmi 9A)' },
    payload: { phone, password: opts.password ?? PASSWORD, client: opts.client ?? 'app' },
  });
  if (res.statusCode !== 200) throw new Error(`login failed ${res.statusCode} ${res.body}`);
  return res.json() as { accessToken: string; refreshToken: string; permissions: string[]; flags: Record<string, boolean>; user: UserView };
}

export async function as(t: TestApp, phone: string, deviceId?: string) {
  const l = await login(t.app, phone, deviceId ? { deviceId } : {});
  return client(t.app, l.accessToken, { 'x-device-id': deviceId ?? `dev-${phone}` });
}
