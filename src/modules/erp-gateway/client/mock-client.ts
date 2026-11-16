import { ctx } from '../../../core/context/index.js';
import { businessDate } from '../../../core/time/index.js';
import { mapBranch, mapCustomer } from '../mappers/laravel-v1.js';
import type { ErpBranch, ErpClient, ErpCustomer, ErpPayment, PostPaymentInput, PostPaymentResult } from '../types.js';

type Posted = Extract<PostPaymentResult, { kind: 'posted' }>;
type FailMode = 'timeout_after_store' | 'timeout' | 'server_error' | 'period_locked' | 'auth';

/**
 * In-memory ERP used for ERP_MODE=mock, local dev and tests. Seeded with Laravel-shaped JSON
 * through the real mappers so mapping is exercised. Behaves like the requested Laravel
 * contract: idempotent by key, rejects settled plans, no advances (E-20 default).
 */
export class MockErpClient implements ErpClient {
  readonly mode = 'mock' as const;
  branches = new Map<string, ErpBranch>();
  customers = new Map<string, ErpCustomer>();
  private payments = new Map<string, { posted: Posted; hash: string }>();
  private seq = 10_000;
  private failQueue: FailMode[] = [];
  allowAdvance = false;
  postCalls = 0;
  unavailable = false;

  seedLaravel(data: { branches?: unknown[]; customers?: unknown[] }): this {
    for (const b of data.branches ?? []) {
      const m = mapBranch(b);
      this.branches.set(m.erpBranchId, m);
    }
    for (const c of data.customers ?? []) this.upsertCustomer(mapCustomer(c));
    return this;
  }

  upsertCustomer(c: ErpCustomer): void {
    this.customers.set(c.erpCustomerId, structuredClone(c));
  }

  /** Simulates a customer disappearing from Laravel (deleted/merged there). */
  removeCustomer(erpCustomerId: string): void {
    this.customers.delete(erpCustomerId);
  }

  /** Test hook: next postPayment calls fail in the given ways. */
  failNext(...modes: FailMode[]): void {
    this.failQueue.push(...modes);
  }

  private nowIso(): string {
    return ctx().clock.now().toISOString();
  }

  private guard() {
    if (this.unavailable) throw new Error('mock ERP unavailable');
  }

  async health() {
    return { ok: !this.unavailable, time: this.nowIso() };
  }

  async listBranches() {
    this.guard();
    return [...this.branches.values()].map((b) => structuredClone(b));
  }

  async listCustomers(q: { erpBranchId?: string; updatedSince?: string | null; cursor?: string | null; pageSize?: number }) {
    this.guard();
    const size = q.pageSize ?? 100;
    const all = [...this.customers.values()]
      .filter((c) => !q.erpBranchId || c.erpBranchId === q.erpBranchId)
      .filter((c) => !q.updatedSince || (c.updatedAt ?? '') >= q.updatedSince)
      .sort((a, b) => (a.updatedAt ?? '').localeCompare(b.updatedAt ?? '') || a.erpCustomerId.localeCompare(b.erpCustomerId));
    const start = q.cursor ? Number(q.cursor) : 0;
    const items = all.slice(start, start + size).map((c) => structuredClone(c));
    return { items, nextCursor: start + size < all.length ? String(start + size) : null, serverTime: this.nowIso() };
  }

  async getCustomer(id: string) {
    this.guard();
    const c = this.customers.get(id);
    return c ? structuredClone(c) : null;
  }

  async listPayments(id: string) {
    this.guard();
    return structuredClone(this.customers.get(id)?.recentPayments ?? []);
  }

  async getPaymentByKey(key: string) {
    this.guard();
    return this.payments.get(key)?.posted ?? null;
  }

  /** Simulate an office payment in Laravel (J-3 conflict journey). */
  officePayment(erpCustomerId: string, erpPlanId: string, amountPoisha: number): void {
    const c = this.customers.get(erpCustomerId);
    const plan = c?.plans.find((p) => p.erpPlanId === erpPlanId);
    if (!c || !plan) throw new Error('unknown plan');
    this.apply(c, plan.erpPlanId, amountPoisha, 'cash', 'office', null, null);
  }

  /** Simulate an office reversal of a payment (FR-COL-009). */
  reversePayment(erpPaymentId: string): void {
    for (const c of this.customers.values()) {
      const p = c.recentPayments.find((x) => x.erpPaymentId === erpPaymentId);
      if (!p) continue;
      p.reversed = true;
      p.reversedAt = this.nowIso();
      const plan = c.plans.find((x) => x.erpPlanId === p.erpPlanId);
      if (plan) {
        plan.paidPoisha -= p.amountPoisha;
        plan.outstandingPoisha += p.amountPoisha;
        if (plan.status === 'completed') plan.status = 'active';
      }
      c.updatedAt = this.nowIso();
      return;
    }
    throw new Error('unknown payment');
  }

  private apply(c: ErpCustomer, planId: string, amount: number, method: string, source: 'office' | 'field', key: string | null, receipt: string | null): ErpPayment {
    const plan = c.plans.find((p) => p.erpPlanId === planId)!;
    plan.paidPoisha += amount;
    plan.outstandingPoisha = Math.max(0, plan.outstandingPoisha - amount);
    let left = amount;
    for (const line of plan.schedule) {
      if (left <= 0) break;
      const paid = line.paidPoisha ?? 0;
      const due = line.amountPoisha - paid;
      if (due <= 0) continue;
      const take = Math.min(due, left);
      if (line.paidPoisha !== null) line.paidPoisha = paid + take;
      left -= take;
    }
    if (plan.outstandingPoisha === 0) plan.status = 'completed';
    const payment: ErpPayment = {
      erpPaymentId: String(++this.seq),
      erpPlanId: planId,
      date: businessDate(ctx().clock.now()),
      amountPoisha: amount,
      method,
      source,
      receiptNo: receipt ?? `R-${this.seq}`,
      idempotencyKey: key,
      reversed: false,
      reversedAt: null,
    };
    c.recentPayments = [payment, ...c.recentPayments].slice(0, 20);
    c.updatedAt = this.nowIso();
    return payment;
  }

  async postPayment(i: PostPaymentInput): Promise<PostPaymentResult> {
    this.postCalls++;
    if (this.unavailable) return { kind: 'transient', error: 'mock ERP unavailable' };
    const fail = this.failQueue.shift();
    if (fail === 'timeout') return { kind: 'transient', error: 'timeout' };
    if (fail === 'server_error') return { kind: 'transient', error: 'ERP 500' };
    if (fail === 'auth') return { kind: 'fatal', code: 'AUTH', error: 'ERP auth failed (401)' };
    if (fail === 'period_locked') return { kind: 'business_error', code: 'PERIOD_LOCKED', message: 'Accounting period closed', details: {} };
    const hash = [i.erpCustomerId, i.erpPlanId, i.amountPoisha, i.method, i.transactionRef ?? '', i.collectedAt.toISOString()].join('|');
    const existing = this.payments.get(i.idempotencyKey);
    if (existing) {
      if (existing.hash !== hash) return { kind: 'fatal', code: 'IDEMPOTENCY_MISMATCH', error: 'Idempotency key reused' };
      return { ...existing.posted, replay: true };
    }
    const c = this.customers.get(i.erpCustomerId);
    const plan = c?.plans.find((p) => p.erpPlanId === i.erpPlanId);
    if (!c || !plan) return { kind: 'business_error', code: 'PLAN_NOT_FOUND', message: 'Plan not found', details: { plan_id: i.erpPlanId } };
    if (c.status !== 'active') return { kind: 'business_error', code: 'CUSTOMER_INACTIVE', message: 'Customer inactive', details: {} };
    if (plan.outstandingPoisha <= 0) return { kind: 'business_error', code: 'PLAN_SETTLED', message: 'Plan already settled', details: { plan_id: i.erpPlanId, outstanding: '0.00' } };
    if (!this.allowAdvance && i.amountPoisha > plan.outstandingPoisha)
      return { kind: 'business_error', code: 'AMOUNT_EXCEEDS_OUTSTANDING', message: 'Amount exceeds outstanding', details: { outstandingPoisha: plan.outstandingPoisha } };
    const p = this.apply(c, plan.erpPlanId, i.amountPoisha, i.method, 'field', i.idempotencyKey, null);
    const posted: Posted = {
      kind: 'posted',
      erpPaymentId: p.erpPaymentId,
      receiptNo: p.receiptNo,
      postedAt: this.nowIso(),
      planOutstandingAfterPoisha: plan.outstandingPoisha,
      customerOutstandingAfterPoisha: c.plans.reduce((s, x) => s + x.outstandingPoisha, 0),
      replay: false,
    };
    this.payments.set(i.idempotencyKey, { posted, hash });
    // Simulates "Laravel stored it but the response never arrived" (07-test-plan §3 scenario 3).
    if (fail === 'timeout_after_store') return { kind: 'transient', error: 'timeout' };
    return posted;
  }
}
