import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startMockErp, type MockErpServer } from '../../mock-erp/server.js';
import { LaravelErpClient } from '../../src/modules/erp-gateway/index.js';

/**
 * The real HTTP client against the HTTP mock ERP: proves client + mappers + recorded fixtures agree
 * end to end. When the Laravel maintainer changes the API, re-record fixtures and fix mappers only.
 */
const TOKEN = 'contract-test-token-not-a-secret';
let erp: MockErpServer;
let client: LaravelErpClient;

const payment = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: randomUUID(),
  erpCustomerId: '100245',
  erpPlanId: '55021',
  erpBranchId: '3',
  amountPoisha: 500000,
  method: 'cash' as const,
  transactionRef: null,
  collectedAt: new Date('2026-11-15T05:20:00Z'),
  employeeId: '7',
  fieldReceiptNo: 'BRL01-FS014-261115-0001',
  physicalReceiptNo: null,
  note: null,
  fieldCollectionId: 'c1',
  geo: null,
  ...over,
});

beforeAll(async () => {
  erp = await startMockErp({ token: TOKEN });
  client = new LaravelErpClient({ baseUrl: erp.url, token: TOKEN, timeoutMs: 5000 });
});
afterAll(async () => erp.close());

describe('LaravelErpClient ↔ mock ERP over HTTP', () => {
  it('health, branches and a customer page map to the internal model', async () => {
    expect((await client.health()).ok).toBe(true);
    const branches = await client.listBranches();
    expect(branches.map((b) => b.code)).toContain('BRL01');
    expect(branches.map((b) => [b.code, b.kind])).toEqual([['BRL01', 'branch'], ['PTK01', 'branch'], ['W', 'warehouse']]);
    const employees = await client.listEmployees();
    expect(employees.find((e) => e.erpEmployeeId === '7')).toMatchObject({
      code: 'EMP-00007',
      active: true,
      erpBranchIds: ['3'],
    });
    const page = await client.listCustomers({ pageSize: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeTruthy();
    const c = page.items[0]!;
    expect(c.erpCustomerId).toBeTruthy();
    expect(Number.isInteger(c.plans[0]!.outstandingPoisha)).toBe(true); // money is integer poisha inside field-api
    expect(c.plans[0]).toMatchObject({ kind: 'installment', invoiceNo: 'INV-55021' });
    const next = await client.listCustomers({ pageSize: 200, cursor: page.nextCursor });
    expect(next.items.length).toBeGreaterThan(0);
    expect(await client.getCustomer('100245')).toBeTruthy();
    expect(await client.getCustomer('999999')).toBeNull();
    expect(Array.isArray(await client.listPayments('100245'))).toBe(true);
  });

  it('posts a payment once per idempotency key and can find it again after a timeout', async () => {
    const p = payment();
    const first = await client.postPayment(p);
    expect(first.kind).toBe('posted');
    const again = await client.postPayment(p);
    expect(again.kind).toBe('posted');
    if (first.kind !== 'posted' || again.kind !== 'posted') throw new Error('unreachable');
    expect(again.erpPaymentId).toBe(first.erpPaymentId);
    expect(again.replay).toBe(true);
    expect(erp.posted()).toBe(1);
    const found = await client.getPaymentByKey(p.idempotencyKey);
    expect(found?.erpPaymentId).toBe(first.erpPaymentId);
    expect(await client.getPaymentByKey(randomUUID())).toBeNull();
  });

  it('a collector without an ERP employee is a conflict and is never sent', async () => {
    const before = erp.posted();
    const r = await client.postPayment(payment({ employeeId: null }));
    expect(r).toMatchObject({ kind: 'business_error', code: 'COLLECTOR_NOT_LINKED' });
    expect(erp.posted()).toBe(before);
  });

  it('an unknown customer is a business rejection, not a transport failure', async () => {
    const r = await client.postPayment(payment({ erpCustomerId: '999999' }));
    expect(r.kind).not.toBe('posted');
    expect(r.kind).not.toBe('transient');
  });

  it('a wrong token is not accepted', async () => {
    const bad = new LaravelErpClient({ baseUrl: erp.url, token: 'wrong-token', timeoutMs: 5000 });
    await expect(bad.listBranches()).rejects.toThrow();
  });
});
