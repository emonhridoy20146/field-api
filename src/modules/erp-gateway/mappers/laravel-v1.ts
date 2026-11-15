/**
 * Laravel integration API v1 → internal types.
 * THE ONLY PLACE (besides test/fixtures/erp and mock-erp/) that knows Laravel field names (CLAUDE.md §2.2).
 * Every name below is an ASSUMPTION until verified (erp-integration-spec §9).
 */
import { z } from 'zod';
import { decimalToPoisha, poishaToDecimal } from '../../../core/money/index.js';
import type {
  ConflictCode,
  CustomerPage,
  ErpBranch,
  ErpCustomer,
  ErpPayment,
  ErpPlan,
  ErpPlanStatus,
  PostPaymentInput,
  PostPaymentResult,
} from '../types.js';

const money = z.union([z.string(), z.number()]).nullable().optional(); // E-08: decimal string or integer
const id = z.union([z.string(), z.number()]).transform(String);
const coord = z.union([z.string(), z.number()]).nullable().optional();

const lvBranch = z.object({
  id,
  code: z.string(),
  name: z.string(),
  name_bn: z.string().nullable().optional(),
  district: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  latitude: coord,
  longitude: coord,
  is_active: z.boolean().optional().default(true),
  updated_at: z.string().nullable().optional(),
});

const lvLine = z.object({ seq: z.number().int(), due_date: z.string(), amount: money, paid: money });

const lvPlan = z.object({
  id,
  product_name: z.string().nullable().optional(),
  sale_date: z.string().nullable().optional(),
  principal: money,
  down_payment: money,
  total_payable: money,
  installment_count: z.number().int().nullable().optional(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  paid_total: money,
  outstanding: money,
  status: z.string().nullable().optional(),
  schedule: z.array(lvLine).optional().default([]),
});

const lvPayment = z.object({
  id,
  plan_id: id.nullable().optional(),
  date: z.string(),
  amount: money,
  method: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  receipt_no: z.string().nullable().optional(),
  idempotency_key: z.string().nullable().optional(),
  is_reversed: z.boolean().optional().default(false),
  reversed_at: z.string().nullable().optional(),
});

const lvCustomer = z.object({
  id,
  code: z.string().nullable().optional(),
  branch_id: id,
  name: z.string(),
  name_bn: z.string().nullable().optional(),
  phones: z.array(z.string()).nullable().optional(),
  guarantor: z.object({ name: z.string().nullable().optional(), phone: z.string().nullable().optional() }).nullable().optional(),
  address: z.string().nullable().optional(),
  area_code: z.string().nullable().optional(),
  latitude: coord,
  longitude: coord,
  status: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  plans: z.array(lvPlan).optional().default([]),
  recent_payments: z.array(lvPayment).optional().default([]),
});

const toNum = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const planStatus = (s: string | null | undefined): ErpPlanStatus => {
  switch ((s ?? 'active').toLowerCase()) {
    case 'completed':
    case 'paid':
    case 'settled':
      return 'completed';
    case 'closed':
      return 'closed';
    case 'defaulted':
      return 'defaulted';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return 'active';
  }
};

export function mapBranch(raw: unknown): ErpBranch {
  const b = lvBranch.parse(raw);
  return {
    erpBranchId: b.id,
    code: b.code,
    name: { en: b.name, bn: b.name_bn ?? b.name },
    district: b.district ?? '',
    address: b.address ?? '',
    lat: toNum(b.latitude),
    lng: toNum(b.longitude),
    active: b.is_active,
    updatedAt: b.updated_at ?? null,
  };
}

export function mapPlan(raw: z.infer<typeof lvPlan>): ErpPlan {
  return {
    erpPlanId: raw.id,
    product: raw.product_name ?? '',
    saleDate: raw.sale_date ?? null,
    principalPoisha: decimalToPoisha(raw.principal),
    downPaymentPoisha: decimalToPoisha(raw.down_payment),
    totalPayablePoisha: decimalToPoisha(raw.total_payable),
    installmentCount: raw.installment_count ?? null,
    startDate: raw.start_date ?? null,
    endDate: raw.end_date ?? null,
    paidPoisha: decimalToPoisha(raw.paid_total),
    outstandingPoisha: decimalToPoisha(raw.outstanding),
    status: planStatus(raw.status),
    schedule: raw.schedule.map((l) => ({
      seq: l.seq,
      dueDate: l.due_date,
      amountPoisha: decimalToPoisha(l.amount),
      paidPoisha: l.paid === null || l.paid === undefined ? null : decimalToPoisha(l.paid),
    })),
  };
}

export function mapPayment(raw: unknown): ErpPayment {
  const p = lvPayment.parse(raw);
  return {
    erpPaymentId: p.id,
    erpPlanId: p.plan_id ?? null,
    date: p.date.slice(0, 10),
    amountPoisha: decimalToPoisha(p.amount),
    method: p.method ?? 'cash',
    source: p.source === 'field_app' || p.source === 'field' ? 'field' : 'office',
    receiptNo: p.receipt_no ?? null,
    idempotencyKey: p.idempotency_key ?? null,
    reversed: p.is_reversed,
    reversedAt: p.reversed_at ?? null,
  };
}

export function mapCustomer(raw: unknown): ErpCustomer {
  const c = lvCustomer.parse(raw);
  const status = (c.status ?? 'active').toLowerCase();
  return {
    erpCustomerId: c.id,
    erpBranchId: c.branch_id,
    code: c.code ?? c.id,
    name: { en: c.name, bn: c.name_bn ?? c.name },
    phones: (c.phones ?? []).filter(Boolean),
    guarantor: c.guarantor ? { name: c.guarantor.name ?? '', phone: c.guarantor.phone ?? '' } : null,
    address: c.address ?? '',
    areaCode: c.area_code ?? null,
    lat: toNum(c.latitude),
    lng: toNum(c.longitude),
    status: status === 'inactive' || status === 'blocked' ? 'inactive' : status === 'closed' ? 'closed' : 'active',
    updatedAt: c.updated_at ?? null,
    plans: c.plans.map(mapPlan),
    recentPayments: c.recent_payments.map((p) => mapPayment(p)),
  };
}

export function mapCustomerPage(raw: unknown): CustomerPage {
  const r = z
    .object({
      data: z.array(z.unknown()),
      meta: z.object({ next_cursor: z.string().nullable().optional(), server_time: z.string().nullable().optional() }).partial().optional(),
      links: z.object({ next: z.string().nullable().optional() }).partial().optional(),
    })
    .parse(raw);
  return { items: r.data.map(mapCustomer), nextCursor: r.meta?.next_cursor ?? null, serverTime: r.meta?.server_time ?? null };
}

/** Dhaka offset timestamp for Laravel (E-09). */
function dhakaIso(d: Date): string {
  const t = new Date(d.getTime() + 6 * 3600_000).toISOString().slice(0, 19);
  return `${t}+06:00`;
}

const METHOD_TO_ERP: Record<string, string> = {
  cash: 'cash',
  bkash: 'bkash',
  nagad: 'nagad',
  rocket: 'rocket',
  bank_transfer: 'bank',
  other_mobile: 'mobile_other',
}; // E-18

export function toPaymentRequest(i: PostPaymentInput): Record<string, unknown> {
  return {
    customer_id: Number.isNaN(Number(i.erpCustomerId)) ? i.erpCustomerId : Number(i.erpCustomerId),
    plan_id: Number.isNaN(Number(i.erpPlanId)) ? i.erpPlanId : Number(i.erpPlanId),
    amount: poishaToDecimal(i.amountPoisha),
    method: METHOD_TO_ERP[i.method] ?? i.method,
    transaction_ref: i.transactionRef,
    collected_at: dhakaIso(i.collectedAt),
    collected_by_employee_id: i.employeeId,
    field_receipt_no: i.fieldReceiptNo,
    physical_receipt_no: i.physicalReceiptNo,
    branch_id: Number.isNaN(Number(i.erpBranchId)) ? i.erpBranchId : Number(i.erpBranchId),
    note: i.note ?? 'Field collection via Howlader Field App',
    source: 'field_app',
    field_collection_id: i.fieldCollectionId,
    geo: i.geo ? { latitude: i.geo.lat.toFixed(6), longitude: i.geo.lng.toFixed(6), accuracy_m: Math.round(i.geo.accuracyM) } : null,
  };
}

const lvPosted = z.object({
  data: z.object({
    id,
    receipt_no: z.string().nullable().optional(),
    posted_at: z.string(),
    plan_outstanding_after: money,
    customer_outstanding_after: money,
  }),
  idempotent_replay: z.boolean().optional().default(false),
});

export function mapPosted(raw: unknown): Extract<PostPaymentResult, { kind: 'posted' }> {
  const r = lvPosted.parse(raw);
  return {
    kind: 'posted',
    erpPaymentId: r.data.id,
    receiptNo: r.data.receipt_no ?? null,
    postedAt: r.data.posted_at,
    planOutstandingAfterPoisha: r.data.plan_outstanding_after == null ? null : decimalToPoisha(r.data.plan_outstanding_after),
    customerOutstandingAfterPoisha: r.data.customer_outstanding_after == null ? null : decimalToPoisha(r.data.customer_outstanding_after),
    replay: r.idempotent_replay,
  };
}

const CONFLICTS: Record<string, ConflictCode> = {
  PLAN_SETTLED: 'PLAN_SETTLED',
  AMOUNT_EXCEEDS_OUTSTANDING: 'AMOUNT_EXCEEDS_OUTSTANDING',
  PLAN_NOT_FOUND: 'PLAN_NOT_FOUND',
  CUSTOMER_NOT_FOUND: 'PLAN_NOT_FOUND',
  CUSTOMER_INACTIVE: 'CUSTOMER_INACTIVE',
  PERIOD_LOCKED: 'PERIOD_LOCKED',
  VALIDATION_FAILED: 'ERP_VALIDATION',
};

/** erp-integration-spec §5.2: map an HTTP error response to a result kind. */
export function mapPaymentError(status: number, body: unknown, retryAfter: string | null): PostPaymentResult {
  const b = (body ?? {}) as { message?: string; error?: { code?: string; details?: Record<string, unknown> }; errors?: Record<string, unknown> };
  const code = b.error?.code ?? (status === 422 && b.errors ? 'VALIDATION_FAILED' : undefined);
  if (code === 'IDEMPOTENCY_MISMATCH') return { kind: 'fatal', code: 'IDEMPOTENCY_MISMATCH', error: b.message ?? 'Idempotency mismatch' };
  if (status === 401 || status === 403) return { kind: 'fatal', code: 'AUTH', error: `ERP auth failed (${status})` };
  if (status === 409 && code === 'CONCURRENT_REQUEST') return { kind: 'transient', error: 'concurrent request', retryAfterSec: 5 };
  if (status === 429) return { kind: 'transient', error: 'rate limited', retryAfterSec: Number(retryAfter) || 30 };
  if (status >= 500) return { kind: 'transient', error: `ERP ${status}` };
  const mapped = code ? CONFLICTS[code] : undefined;
  if (mapped) return { kind: 'business_error', code: mapped, message: b.message ?? code!, details: { ...(b.error?.details ?? {}), ...(b.errors ? { errors: b.errors } : {}) } };
  if (status === 404) return { kind: 'business_error', code: 'PLAN_NOT_FOUND', message: b.message ?? 'Not found', details: {} };
  if (status === 423) return { kind: 'business_error', code: 'PERIOD_LOCKED', message: b.message ?? 'Period locked', details: {} };
  return { kind: 'business_error', code: 'ERP_VALIDATION', message: b.message ?? `ERP ${status}`, details: b.error?.details ?? {} };
}
