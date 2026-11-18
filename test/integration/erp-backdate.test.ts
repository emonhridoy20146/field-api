import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from '../helpers/app.js';

// OD-28, decided by the owner 2026-11-18: a field collection of any past date is accepted.
let t: TestApp;
const DAY = 86_400_000;
const payment = (collectedAt: Date, amountPoisha = 100_000) => ({
  idempotencyKey: randomUUID(),
  erpCustomerId: '100245',
  erpPlanId: '55021',
  erpBranchId: '3',
  amountPoisha,
  method: 'cash' as const,
  transactionRef: null,
  collectedAt,
  employeeId: '7',
  fieldReceiptNo: 'BRL01-FS014-260916-0001',
  physicalReceiptNo: null,
  note: null,
  fieldCollectionId: randomUUID(),
  geo: null,
});

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());

describe('back-dated collections (OD-28)', () => {
  it('the ERP takes a collection of any past date by default', async () => {
    expect(t.erp.maxBackdateDays).toBeNull();
    const r = await t.erp.postPayment(payment(new Date(t.clock.now().getTime() - 60 * DAY)));
    expect(r.kind).toBe('posted');
  });

  it('a configured window still refuses older collections, and the future is always refused', async () => {
    t.erp.maxBackdateDays = 7;
    const old = await t.erp.postPayment(payment(new Date(t.clock.now().getTime() - 30 * DAY)));
    expect(old).toMatchObject({ kind: 'business_error', code: 'PERIOD_LOCKED' });
    t.erp.maxBackdateDays = null;
    const future = await t.erp.postPayment(payment(new Date(t.clock.now().getTime() + 2 * DAY)));
    expect(future.kind).not.toBe('posted');
  });
});
