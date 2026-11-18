import { ctx } from '../../../core/context/index.js';
import { businessDate, diffDays } from '../../../core/time/index.js';
import { mapBranch, mapCustomer, mapEmployee } from '../mappers/laravel-v1.js';
import type {
  ErpBranch,
  ErpClient,
  ErpCustomer,
  ErpEmployee,
  ErpPayment,
  PostPaymentInput,
  PostPaymentResult,
} from '../types.js';

type Posted = Extract<PostPaymentResult, { kind: 'posted' }>;
type FailMode = 'timeout_after_store' | 'timeout' | 'server_error' | 'period_locked' | 'auth';

/** FOS method → ERP payment method type (same table as the Laravel mapper). */
const METHOD_TYPE: Record<string, string> = {
  cash: 'cash',
  bkash: 'mobile_banking',
  nagad: 'mobile_banking',
  rocket: 'mobile_banking',
  other_mobile: 'mobile_banking',
  bank_transfer: 'bank',
};

/**
 * In-memory ERP used for ERP_MODE=mock, local dev and tests. Seeded with ERP-shaped JSON through
 * the real mappers so mapping is exercised. It applies the same rules, in the same order, as the
 * ERP field API (erp-integration-spec v2 §4.8): idempotent by key, closed/settled invoices refused,
 * no overpayment, back-date window, collector required, method type available at the branch,
 * one payment per day per installment invoice.
 */
export class MockErpClient implements ErpClient {
  readonly mode = 'mock' as const;
  branches = new Map<string, ErpBranch>();
  customers = new Map<string, ErpCustomer>();
  employees = new Map<string, ErpEmployee>();
  private payments = new Map<string, { posted: Posted; hash: string }>();
  private seq = 10_000;
  private failQueue: FailMode[] = [];
  allowAdvance = false;
  /** OD-27: the integration user does not have installment.allow-same-day-duplicate by default. */
  allowSameDay = false;
  /** ERP method types each branch can take; a branch missing here takes every type. */
  methodTypes = new Map<string, string[]>();
  /** OD-28 (owner, 2026-11-18): any past date by default; a number mirrors FIELD_API_MAX_BACKDATE_DAYS. */
  maxBackdateDays: number | null = null;
  postCalls = 0;
  unavailable = false;

  seedLaravel(data: { branches?: unknown[]; customers?: unknown[]; employees?: unknown[] }): this {
    for (const b of data.branches ?? []) {
      const m = mapBranch(b);
      this.branches.set(m.erpBranchId, m);
    }
    for (const e of data.employees ?? []) {
      const m = mapEmployee(e);
      this.employees.set(m.erpEmployeeId, m);
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

  async listEmployees() {
    this.guard();
    return [...this.employees.values()].map((e) => structuredClone(e));
  }

  async listCustomers(q: {
    erpBranchId?: string;
    updatedSince?: string | null;
    cursor?: string | null;
    pageSize?: number;
  }) {
    this.guard();
    const size = q.pageSize ?? 100;
    const since = q.updatedSince ? Date.parse(q.updatedSince) : null;
    const all = [...this.customers.values()]
      .filter((c) => !q.erpBranchId || c.erpBranchId === q.erpBranchId)
      .filter((c) => since === null || Date.parse(c.updatedAt ?? '') >= since)
      .sort(
        (a, b) => Number(a.erpCustomerId) - Number(b.erpCustomerId) || a.erpCustomerId.localeCompare(b.erpCustomerId),
      );
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
    this.apply(c, plan.erpPlanId, amountPoisha, 'cash', 'office', null, null, businessDate(ctx().clock.now()), null);
  }

  /** Simulate the office removing a payment in the ERP (hard delete + audit log → reversed, FR-COL-009). */
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
        // Undo the waterfall newest-first, like the ERP removes the payment's line slices.
        let left = p.amountPoisha;
        for (const line of [...plan.schedule].reverse()) {
          if (left <= 0) break;
          if (line.paidPoisha === null || line.paidPoisha <= 0) continue;
          const take = Math.min(line.paidPoisha, left);
          line.paidPoisha -= take;
          left -= take;
        }
        // The ERP deletes the removed payment's installment allocations with it (1.14.0 line payments).
        for (const line of plan.schedule)
          if (line.payments) line.payments = line.payments.filter((x) => x.erpPaymentId !== p.erpPaymentId);
        if (plan.status === 'completed') plan.status = 'active';
      }
      c.updatedAt = this.nowIso();
      return;
    }
    throw new Error('unknown payment');
  }

  private apply(
    c: ErpCustomer,
    planId: string,
    amount: number,
    method: string,
    source: 'office' | 'field',
    key: string | null,
    receipt: string | null,
    date: string,
    employeeId: string | null,
  ): ErpPayment {
    const plan = c.plans.find((p) => p.erpPlanId === planId)!;
    plan.paidPoisha += amount;
    plan.outstandingPoisha = Math.max(0, plan.outstandingPoisha - amount);
    this.seq++;
    const erpPaymentId = String(this.seq);
    const receiptNo = receipt ?? `PAY-${date.replace(/-/g, '')}-${String(this.seq).padStart(5, '0')}`;
    let left = amount;
    for (const line of plan.schedule) {
      if (left <= 0) break;
      const paid = line.paidPoisha ?? 0;
      const due = line.amountPoisha - paid;
      if (due <= 0) continue;
      const take = Math.min(due, left);
      if (line.paidPoisha !== null) {
        line.paidPoisha = paid + take;
        // Like installment_payment_allocations in the ERP (1.14.0).
        line.payments = [...(line.payments ?? []), { erpPaymentId, receiptNo, date, amountPoisha: take }];
      }
      left -= take;
    }
    if (plan.outstandingPoisha === 0) plan.status = 'completed';
    const employee = employeeId ? this.employees.get(employeeId) : undefined;
    const payment: ErpPayment = {
      erpPaymentId,
      erpPlanId: planId,
      date,
      amountPoisha: amount,
      method,
      source,
      receiptNo,
      idempotencyKey: key,
      reversed: false,
      reversedAt: null,
      methodLabel: method === 'cash' ? 'Cash' : method,
      collectorName: employee?.name ?? null,
      collectorEmployeeId: employeeId,
      advance: false,
      discountPoisha: 0,
    };
    c.recentPayments = [payment, ...c.recentPayments].slice(0, 20);
    c.updatedAt = this.nowIso();
    return payment;
  }

  private reject(
    code: Extract<PostPaymentResult, { kind: 'business_error' }>['code'],
    message: string,
    details: Record<string, unknown> = {},
  ): PostPaymentResult {
    return { kind: 'business_error', code, message, details };
  }

  async postPayment(i: PostPaymentInput): Promise<PostPaymentResult> {
    this.postCalls++;
    if (this.unavailable) return { kind: 'transient', error: 'mock ERP unavailable' };
    const fail = this.failQueue.shift();
    if (fail === 'timeout') return { kind: 'transient', error: 'timeout' };
    if (fail === 'server_error') return { kind: 'transient', error: 'ERP 500' };
    if (fail === 'auth') return { kind: 'fatal', code: 'AUTH', error: 'ERP auth failed (401)' };
    if (fail === 'period_locked')
      return this.reject('PERIOD_LOCKED', 'Collection date is older than the allowed back-date window.');
    const hash = [
      i.erpCustomerId,
      i.erpPlanId,
      i.amountPoisha,
      METHOD_TYPE[i.method] ?? i.method,
      i.transactionRef ?? '',
      i.collectedAt.toISOString(),
      i.employeeId ?? '',
    ].join('|');
    const existing = this.payments.get(i.idempotencyKey);
    if (existing) {
      if (existing.hash !== hash)
        return { kind: 'fatal', code: 'IDEMPOTENCY_MISMATCH', error: 'Idempotency key reused' };
      return { ...existing.posted, replay: true };
    }
    // Same order as the ERP field API (erp-integration-spec v2 §4.8).
    const c = this.customers.get(i.erpCustomerId);
    const plan = c?.plans.find((p) => p.erpPlanId === i.erpPlanId);
    if (!c || !plan)
      return this.reject('PLAN_NOT_FOUND', 'Invoice not found for this customer.', { sales_invoice_id: i.erpPlanId });
    if (plan.status === 'closed' || plan.status === 'cancelled')
      return this.reject('PLAN_CLOSED', 'This invoice is not open for collection.', { status: plan.status });
    if (c.status !== 'active') return this.reject('CUSTOMER_INACTIVE', 'Customer is inactive.');
    if (plan.outstandingPoisha <= 0)
      return this.reject('PLAN_SETTLED', 'Invoice already settled.', { outstanding: '0.00' });
    if (!this.allowAdvance && i.amountPoisha > plan.outstandingPoisha)
      return this.reject('AMOUNT_EXCEEDS_OUTSTANDING', 'Amount exceeds the invoice due.', {
        outstandingPoisha: plan.outstandingPoisha,
      });
    const today = businessDate(ctx().clock.now());
    const date = businessDate(i.collectedAt);
    if (date > today) return this.reject('ERP_VALIDATION', 'collected_at is in the future.');
    if (this.maxBackdateDays !== null && diffDays(date, today) > this.maxBackdateDays)
      return this.reject('PERIOD_LOCKED', 'Collection date is older than the allowed back-date window.');
    const employee = i.employeeId ? this.employees.get(i.employeeId) : undefined;
    if (!i.employeeId || (this.employees.size > 0 && !employee?.active))
      return this.reject('COLLECTOR_NOT_LINKED', 'Collector is not an active ERP employee.', {
        collector_employee_id: i.employeeId,
      });
    const type = METHOD_TYPE[i.method] ?? 'cash';
    const branchTypes = this.methodTypes.get(plan.erpBranchId ?? c.erpBranchId);
    if (branchTypes && !branchTypes.includes(type))
      return this.reject('METHOD_NOT_AVAILABLE', 'No active payment method of this type at the invoice branch.', {
        method_type: type,
      });
    if (
      (plan.kind ?? 'installment') === 'installment' &&
      !this.allowSameDay &&
      c.recentPayments.some((p) => p.erpPlanId === plan.erpPlanId && p.date === date && !p.reversed && !p.advance)
    )
      return this.reject(
        'DUPLICATE_SAME_DAY',
        'A payment is already recorded on this installment invoice for that day.',
        { payment_date: date },
      );
    const p = this.apply(
      c,
      plan.erpPlanId,
      i.amountPoisha,
      i.method,
      'field',
      i.idempotencyKey,
      null,
      date,
      i.employeeId,
    );
    const posted: Posted = {
      kind: 'posted',
      erpPaymentId: p.erpPaymentId,
      receiptNo: p.receiptNo,
      postedAt: this.nowIso(),
      planOutstandingAfterPoisha: plan.outstandingPoisha,
      customerOutstandingAfterPoisha: c.plans
        .filter((x) => x.status !== 'closed' && x.status !== 'cancelled')
        .reduce((s, x) => s + x.outstandingPoisha, 0),
      replay: false,
    };
    this.payments.set(i.idempotencyKey, { posted, hash });
    // Simulates "Laravel stored it but the response never arrived" (07-test-plan §3 scenario 3).
    if (fail === 'timeout_after_store') return { kind: 'transient', error: 'timeout' };
    return posted;
  }
}
