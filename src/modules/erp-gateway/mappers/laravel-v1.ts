/**
 * Howlader ERP field integration API v1 (`/api/field/v1`) → internal types.
 * THE ONLY PLACE (besides test/fixtures/erp and mock-erp/) that knows Laravel field names (CLAUDE.md §2.2).
 * Shapes verified against the ERP code and a copy of its data (docs/erp-findings.md, erp-integration-spec v2).
 *
 * Key decisions (ADR-033):
 * - One FOS plan = one ERP receivable invoice (`sales_invoices`, sale_type installment|credit). erpPlanId is the
 *   invoice id because the ERP records payments against invoices.
 * - Schedule line amount = due + late fee; paid comes from the ERP; zero lines are "rolled" (moved forward).
 * - Returned/cancelled invoices are not collectable (status closed/cancelled).
 * - Payments removed in the ERP (hard delete + audit log) come back as `reversed`.
 */
import { z } from 'zod';
import { decimalToPoisha, poishaToDecimal } from '../../../core/money/index.js';
import type {
  ConflictCode,
  CustomerPage,
  ErpBranch,
  ErpCustomer,
  ErpEmployee,
  ErpGuarantor,
  ErpPayment,
  ErpPlan,
  ErpPlanFrequency,
  ErpPlanStatus,
  ErpRisk,
  ErpScheduleLine,
  PostPaymentInput,
  PostPaymentResult,
} from '../types.js';

const money = z.union([z.string(), z.number()]).nullable().optional(); // decimal string "1250.00"
const id = z.union([z.string(), z.number()]).transform(String);
const optId = id.nullable().optional();
const coord = z.union([z.string(), z.number()]).nullable().optional();
const str = z.string().nullable().optional();

// ---------------- reference data ----------------

const lvBranch = z.object({
  id,
  code: z.string(),
  name: z.string(),
  type: str,
  address: str,
  phone: str,
  manager_name: str,
  is_active: z.boolean().optional().default(true),
  updated_at: str,
  // Not in the ERP today (findings §2.1); read if a later API version adds them.
  name_bn: str,
  district: str,
  latitude: coord,
  longitude: coord,
});

const toNum = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const poisha = (v: string | number | null | undefined): number => decimalToPoisha(v ?? 0);

export function mapBranch(raw: unknown): ErpBranch {
  const b = lvBranch.parse(raw);
  return {
    erpBranchId: b.id,
    code: b.code.trim(),
    name: { en: b.name, bn: b.name_bn ?? b.name },
    district: b.district ?? '',
    address: b.address ?? '',
    lat: toNum(b.latitude),
    lng: toNum(b.longitude),
    active: b.is_active,
    updatedAt: b.updated_at ?? null,
    kind: b.type === 'warehouse' ? 'warehouse' : 'branch',
  };
}

const lvEmployee = z.object({
  id,
  employee_code: str,
  name: str,
  phone: str,
  user_id: optId,
  branch_ids: z.array(id).optional().default([]),
  is_active: z.boolean().optional().default(true),
  updated_at: str,
});

export function mapEmployee(raw: unknown): ErpEmployee {
  const e = lvEmployee.parse(raw);
  return {
    erpEmployeeId: e.id,
    code: e.employee_code ?? e.id,
    name: (e.name ?? '').trim(),
    phone: normalizePhones([e.phone])[0] ?? null,
    erpBranchIds: e.branch_ids,
    active: e.is_active,
  };
}

// ---------------- phones (findings §2.2: 4 % are free text) ----------------

const BD_MOBILE = /^01[3-9]\d{8}$/;

function normalizeMobile(digits: string): string | null {
  let d = digits;
  if (d.length === 13 && d.startsWith('880')) d = d.slice(2);
  else if (d.length === 12 && d.startsWith('88')) d = d.slice(2);
  else if (d.length === 10 && /^1[3-9]/.test(d)) d = `0${d}`;
  return BD_MOBILE.test(d) ? d : null;
}

/**
 * Every Bangladeshi mobile number found in the ERP phone fields, as `01XXXXXXXXX`, de-duplicated.
 * Handles "a, b", "a / b", "+880…", numbers split by a space or dash, and "01711111111, 22222222"
 * (second number sharing the operator prefix). If nothing valid is found the raw text is kept so
 * staff still see what the office typed.
 */
export function normalizePhones(values: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  const raw: string[] = [];
  for (const v of values) {
    const text = (v ?? '').trim();
    if (!text) continue;
    raw.push(text);
    const tokens = text.match(/\d+/g) ?? [];
    let prev: string | null = null;
    for (let i = 0; i < tokens.length; i++) {
      let found = normalizeMobile(tokens[i]!);
      let joined = tokens[i]!;
      for (let j = i + 1; !found && j < tokens.length && joined.length < 13; j++) {
        joined += tokens[j]!;
        found = normalizeMobile(joined);
        if (found) i = j;
      }
      if (!found && prev && tokens[i]!.length === 8) found = normalizeMobile(prev.slice(0, 3) + tokens[i]!);
      if (found) {
        if (!out.includes(found)) out.push(found);
        prev = found;
      }
    }
  }
  if (out.length) return out;
  return raw.filter((r) => /\d/.test(r)).slice(0, 2);
}

// ---------------- customers ----------------

const lvGuarantor = z.object({
  customer_id: optId,
  name: str,
  phones: z
    .array(z.union([z.string(), z.number()]).transform(String))
    .nullable()
    .optional(),
  address: str,
});

const lvLine = z.object({
  id: optId,
  installment_no: z.number().int(),
  due_date: z.string(),
  due_amount: money,
  paid_amount: money,
  late_fee_amount: money,
  remaining_amount: money,
  status: str,
});

const lvInstallmentPlan = z.object({
  id,
  status: str,
  total_amount: money,
  down_payment: money,
  financed_amount: money,
  remaining_amount: money,
  frequency: str,
  custom_days: z.number().int().nullable().optional(),
  installment_count: z.number().int().nullable().optional(),
  penalty_enabled: z.boolean().optional(),
  schedules: z.array(lvLine).optional().default([]),
});

const lvItem = z.object({
  line_id: optId,
  product_id: optId,
  name: str,
  model_number: str,
  qty: z.union([z.number(), z.string()]).optional(),
  line_total: money,
  serials: z.array(z.string()).optional().default([]),
});

const lvInvoice = z.object({
  id,
  invoice_number: str,
  invoice_date: str,
  branch_id: optId,
  sale_type: z.string(),
  status: z.string(),
  payment_status: str,
  collectable: z.boolean().optional(),
  grand_total: money,
  discount_total: money,
  amount_paid: money,
  amount_due: money,
  written_off: money,
  credit_due_date: str,
  items: z.array(lvItem).optional().default([]),
  guarantor: lvGuarantor.nullable().optional(),
  installment_plan: lvInstallmentPlan.nullable().optional(),
  updated_at: str,
});

const lvPayment = z.object({
  id,
  payment_number: str,
  customer_id: optId,
  sales_invoice_id: optId,
  payment_date: z.string(),
  amount: money,
  settlement_discount: money,
  payment_method: str,
  payment_method_id: optId,
  payment_method_name: str,
  payment_method_type: str,
  collector_employee_id: optId,
  collector_name: str,
  reference_no: str,
  is_advance: z.boolean().optional().default(false),
  source: str,
  idempotency_key: str,
  created_at: str,
});

const lvRemoved = z.object({
  id: optId,
  payment_number: str,
  payment_date: str,
  sales_invoice_id: optId,
  amount: money,
  removed_at: str,
  idempotency_key: str,
});

const lvRisk = z.object({
  grade: str,
  risk_level: str,
  classification: str,
  score: money,
  overdue_count: z.number().int().nullable().optional(),
  max_days_late: z.number().int().nullable().optional(),
  computed_at: str,
});

const lvCustomer = z.object({
  id,
  customer_code: str,
  name: z.string(),
  phone: str,
  phone_numbers: z
    .array(z.union([z.string(), z.number()]).transform(String))
    .nullable()
    .optional(),
  branch_id: optId,
  branch_source: str,
  address: str,
  detailed_address: str,
  location_instructions: str,
  latitude: coord,
  longitude: coord,
  is_active: z.boolean().optional().default(true),
  outstanding_balance: money,
  default_guarantor: lvGuarantor.nullable().optional(),
  risk: lvRisk.nullable().optional(),
  updated_at: str,
  changed_at: str,
  invoices: z.array(lvInvoice).optional().default([]),
  recent_payments: z.array(lvPayment).optional().default([]),
  removed_payments: z.array(lvRemoved).optional().default([]),
  // Not in the ERP (findings E-11, E-25); read if a later version adds them.
  name_bn: str,
  area_code: str,
});

type LvInvoice = z.infer<typeof lvInvoice>;
type LvGuarantor = z.infer<typeof lvGuarantor>;

const FREQUENCIES: ErpPlanFrequency[] = ['monthly', 'weekly', 'daily', 'custom'];

function mapGuarantor(g: LvGuarantor | null | undefined): ErpGuarantor | null {
  if (!g || !(g.name ?? '').trim()) return null;
  const phones = normalizePhones(g.phones ?? []);
  return { name: g.name!.trim(), phone: phones[0] ?? '', phones, address: g.address ?? null };
}

function planStatus(inv: LvInvoice, duePoisha: number): ErpPlanStatus {
  const s = inv.status.toLowerCase();
  if (s === 'cancelled') return 'cancelled';
  if (s === 'returned' || s === 'draft') return 'closed';
  if (inv.sale_type !== 'installment' && inv.sale_type !== 'credit') return 'closed';
  if (duePoisha <= 0) return 'completed';
  if (inv.collectable === false) return 'closed';
  if ((inv.installment_plan?.status ?? '').toLowerCase() === 'defaulted') return 'defaulted';
  return 'active';
}

function productLabel(inv: LvInvoice): string {
  const parts = inv.items
    .map((i) => {
      const name = [i.name, i.model_number].filter((x) => !!x && x.trim()).join(' ');
      const qty = Number(i.qty ?? 1);
      return name ? (qty > 1 ? `${name} ×${qty}` : name) : '';
    })
    .filter(Boolean);
  return parts.join(', ') || inv.invoice_number || '';
}

export function mapInvoice(inv: LvInvoice): ErpPlan {
  const due = poisha(inv.amount_due);
  const paid = poisha(inv.amount_paid);
  const writtenOff = poisha(inv.written_off);
  const plan = inv.installment_plan ?? null;
  const kind = inv.sale_type === 'credit' ? 'credit' : 'installment';
  let schedule: ErpScheduleLine[];
  if (plan) {
    schedule = [...plan.schedules]
      .sort((a, b) => a.installment_no - b.installment_no)
      .map((l) => {
        const dueAmt = poisha(l.due_amount);
        const fee = poisha(l.late_fee_amount);
        const linePaid = poisha(l.paid_amount);
        return {
          seq: l.installment_no,
          dueDate: l.due_date.slice(0, 10),
          amountPoisha: dueAmt + fee,
          paidPoisha: l.paid_amount === null || l.paid_amount === undefined ? null : linePaid,
          lateFeePoisha: fee,
          rolled: dueAmt === 0 && fee === 0 && linePaid === 0,
        };
      });
  } else {
    // Credit sale: one amount due on credit_due_date (findings §2.3). Write-offs count as settled.
    schedule = [
      {
        seq: 1,
        dueDate: (inv.credit_due_date ?? inv.invoice_date ?? '').slice(0, 10),
        amountPoisha: paid + due + writtenOff,
        paidPoisha: paid + writtenOff,
        lateFeePoisha: 0,
        rolled: false,
      },
    ].filter((l) => !!l.dueDate);
  }
  const dates = schedule.map((l) => l.dueDate).sort();
  const total = poisha(inv.grand_total);
  const down = plan ? poisha(plan.down_payment) : 0;
  const frequency = (plan?.frequency ?? null) as ErpPlanFrequency | null;
  return {
    erpPlanId: inv.id,
    product: productLabel(inv),
    saleDate: inv.invoice_date ? inv.invoice_date.slice(0, 10) : null,
    principalPoisha: plan ? poisha(plan.financed_amount) : total,
    downPaymentPoisha: down,
    totalPayablePoisha: total,
    installmentCount: plan ? (plan.installment_count ?? schedule.length) : 1,
    startDate: dates[0] ?? null,
    // No end-date column in the ERP: the last line's due date is the final due date (E-05).
    endDate: dates[dates.length - 1] ?? null,
    paidPoisha: paid,
    outstandingPoisha: due,
    status: planStatus(inv, due),
    schedule,
    kind,
    invoiceNo: inv.invoice_number ?? null,
    erpInstallmentPlanId: plan ? plan.id : null,
    erpBranchId: inv.branch_id ?? null,
    frequency: frequency && FREQUENCIES.includes(frequency) ? frequency : plan ? 'monthly' : null,
    customDays: plan?.custom_days ?? null,
    items: inv.items.map((i) => ({
      name: i.name ?? '',
      model: i.model_number ?? null,
      qty: Number(i.qty ?? 1) || 1,
      serials: i.serials,
    })),
    guarantor: mapGuarantor(inv.guarantor),
    writtenOffPoisha: writtenOff,
  };
}

/** ERP method type → the method words FOS already uses for display. */
function methodOf(type: string | null | undefined, legacy: string | null | undefined): string {
  switch ((type ?? '').toLowerCase()) {
    case 'cash':
      return 'cash';
    case 'mobile_banking':
      return 'other_mobile';
    case 'bank':
      return 'bank_transfer';
    case 'card_terminal':
      return 'card';
    default:
      return legacy ?? 'cash';
  }
}

export function mapPayment(raw: unknown): ErpPayment {
  const p = lvPayment.parse(raw);
  return {
    erpPaymentId: p.id,
    erpPlanId: p.sales_invoice_id ?? null,
    date: p.payment_date.slice(0, 10),
    amountPoisha: poisha(p.amount),
    method: methodOf(p.payment_method_type, p.payment_method),
    source: p.source === 'field_app' ? 'field' : 'office',
    receiptNo: p.payment_number ?? null,
    idempotencyKey: p.idempotency_key ?? null,
    reversed: false,
    reversedAt: null,
    methodLabel: p.payment_method_name ?? null,
    collectorName: p.collector_name ?? null,
    collectorEmployeeId: p.collector_employee_id ?? null,
    advance: p.is_advance,
    discountPoisha: poisha(p.settlement_discount),
  };
}

/** Dhaka business date of an ISO timestamp. */
function dhakaDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso.slice(0, 10) : new Date(t + 6 * 3600_000).toISOString().slice(0, 10);
}

/** A payment the office removed in the ERP (hard delete + audit log) → a reversed payment. */
export function mapRemovedPayment(raw: unknown): ErpPayment {
  const r = lvRemoved.parse(raw);
  const fromNumber = /^PAY-(\d{4})(\d{2})(\d{2})-/.exec(r.payment_number ?? '');
  const date =
    r.payment_date?.slice(0, 10) ??
    (fromNumber ? `${fromNumber[1]}-${fromNumber[2]}-${fromNumber[3]}` : r.removed_at ? dhakaDate(r.removed_at) : '');
  return {
    erpPaymentId: r.id ?? `removed:${r.payment_number ?? r.removed_at ?? ''}`,
    erpPlanId: r.sales_invoice_id ?? null,
    date,
    amountPoisha: poisha(r.amount),
    method: '',
    source: r.idempotency_key ? 'field' : 'office',
    receiptNo: r.payment_number ?? null,
    idempotencyKey: r.idempotency_key ?? null,
    reversed: true,
    reversedAt: r.removed_at ?? null,
  };
}

function mapRisk(r: z.infer<typeof lvRisk> | null | undefined): ErpRisk | null {
  if (!r) return null;
  return {
    grade: r.grade ?? null,
    level: r.risk_level ?? null,
    classification: r.classification ?? null,
    overdueCount: r.overdue_count ?? 0,
    maxDaysLate: r.max_days_late ?? 0,
    computedAt: r.computed_at ?? null,
  };
}

export function mapCustomer(raw: unknown): ErpCustomer {
  const c = lvCustomer.parse(raw);
  const plans = c.invoices.map(mapInvoice);
  // Customer-level guarantor: the one on the most recent open plan, else the customer's default (ERP display rule).
  const open = [...plans].reverse().find((p) => p.status === 'active' && p.guarantor);
  const guarantor = open?.guarantor ?? mapGuarantor(c.default_guarantor);
  const payments = c.recent_payments.map((p) => mapPayment(p));
  const seen = new Set(payments.map((p) => p.erpPaymentId));
  const removed = c.removed_payments.map((p) => mapRemovedPayment(p)).filter((p) => !seen.has(p.erpPaymentId));
  return {
    erpCustomerId: c.id,
    erpBranchId: c.branch_id ?? '',
    code: c.customer_code ?? c.id,
    // The ERP stores no Bangla names (E-25).
    name: { en: c.name, bn: c.name_bn ?? c.name },
    phones: normalizePhones([c.phone, ...(c.phone_numbers ?? [])]),
    guarantor: guarantor ? { name: guarantor.name, phone: guarantor.phone } : null,
    address: c.address ?? '',
    areaCode: c.area_code ?? null,
    lat: toNum(c.latitude),
    lng: toNum(c.longitude),
    status: c.is_active ? 'active' : 'inactive',
    // changed_at covers invoices, schedule lines and payments, which the customer row's updated_at does not.
    updatedAt: c.changed_at ?? c.updated_at ?? null,
    plans,
    recentPayments: [...payments, ...removed],
    detailedAddress: c.detailed_address ?? null,
    directions: c.location_instructions ?? null,
    risk: mapRisk(c.risk),
    branchSource: c.branch_source === 'customer' || c.branch_source === 'last_invoice' ? c.branch_source : null,
  };
}

export function mapCustomerPage(raw: unknown): CustomerPage {
  const r = z
    .object({
      data: z.array(z.unknown()),
      meta: z
        .object({ next_cursor: z.string().nullable().optional(), server_time: z.string().nullable().optional() })
        .partial()
        .optional(),
    })
    .parse(raw);
  return {
    items: r.data.map(mapCustomer),
    nextCursor: r.meta?.next_cursor ?? null,
    serverTime: r.meta?.server_time ?? null,
  };
}

// ---------------- payment posting ----------------

/** Dhaka offset timestamp for Laravel (E-09). */
function dhakaIso(d: Date): string {
  const t = new Date(d.getTime() + 6 * 3600_000).toISOString().slice(0, 19);
  return `${t}+06:00`;
}

/** FOS method → ERP payment method type (the ERP picks the branch's method of that type). */
const METHOD_TO_ERP_TYPE: Record<string, string> = {
  cash: 'cash',
  bkash: 'mobile_banking',
  nagad: 'mobile_banking',
  rocket: 'mobile_banking',
  other_mobile: 'mobile_banking',
  bank_transfer: 'bank',
};

/** Lets the ERP pick the right mobile wallet when a branch has more than one. */
const MOBILE_PROVIDER: Record<string, string> = { bkash: 'bkash', nagad: 'nagad', rocket: 'rocket' };

const asInt = (v: string): number | string => (/^\d+$/.test(v) ? Number(v) : v);

export function toPaymentRequest(i: PostPaymentInput): Record<string, unknown> {
  const note = [i.physicalReceiptNo ? `Book receipt ${i.physicalReceiptNo}` : null, i.note]
    .filter((x): x is string => !!x && !!x.trim())
    .join(' · ')
    .slice(0, 300);
  return {
    sales_invoice_id: asInt(i.erpPlanId),
    customer_id: asInt(i.erpCustomerId),
    amount: poishaToDecimal(i.amountPoisha),
    collected_at: dhakaIso(i.collectedAt),
    method_type: METHOD_TO_ERP_TYPE[i.method] ?? 'cash',
    mobile_provider: MOBILE_PROVIDER[i.method] ?? null,
    collector_employee_id: i.employeeId ? asInt(i.employeeId) : null,
    transaction_ref: i.transactionRef,
    field_receipt_no: i.fieldReceiptNo,
    field_collection_id: i.fieldCollectionId,
    note: note || null,
  };
}

const lvPosted = z.object({
  data: z.object({
    id,
    payment_number: str,
    posted_at: z.string(),
    invoice_amount_due_after: money,
    customer_outstanding_after: money,
  }),
  idempotent_replay: z.boolean().optional().default(false),
});

export function mapPosted(raw: unknown): Extract<PostPaymentResult, { kind: 'posted' }> {
  const r = lvPosted.parse(raw);
  return {
    kind: 'posted',
    erpPaymentId: r.data.id,
    receiptNo: r.data.payment_number ?? null,
    postedAt: r.data.posted_at,
    planOutstandingAfterPoisha:
      r.data.invoice_amount_due_after == null ? null : decimalToPoisha(r.data.invoice_amount_due_after),
    customerOutstandingAfterPoisha:
      r.data.customer_outstanding_after == null ? null : decimalToPoisha(r.data.customer_outstanding_after),
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
  ERP_REJECTED: 'ERP_VALIDATION',
  PLAN_CLOSED: 'PLAN_CLOSED',
  DUPLICATE_SAME_DAY: 'DUPLICATE_SAME_DAY',
  METHOD_NOT_AVAILABLE: 'METHOD_NOT_AVAILABLE',
  COLLECTOR_NOT_LINKED: 'COLLECTOR_NOT_LINKED',
};

/** erp-integration-spec §6: map an HTTP error response to a result kind. */
export function mapPaymentError(status: number, body: unknown, retryAfter: string | null): PostPaymentResult {
  const b = (body ?? {}) as {
    message?: string;
    error?: { code?: string; details?: Record<string, unknown> };
    errors?: Record<string, unknown>;
  };
  const code = b.error?.code ?? (status === 422 && b.errors ? 'VALIDATION_FAILED' : undefined);
  if (code === 'IDEMPOTENCY_MISMATCH')
    return { kind: 'fatal', code: 'IDEMPOTENCY_MISMATCH', error: b.message ?? 'Idempotency mismatch' };
  if (status === 401 || status === 403) return { kind: 'fatal', code: 'AUTH', error: `ERP auth failed (${status})` };
  if (status === 409 && code === 'CONCURRENT_REQUEST')
    return { kind: 'transient', error: 'concurrent request', retryAfterSec: 5 };
  if (status === 429) return { kind: 'transient', error: 'rate limited', retryAfterSec: Number(retryAfter) || 30 };
  if (status >= 500) return { kind: 'transient', error: `ERP ${status}` };
  const mapped = code ? CONFLICTS[code] : undefined;
  if (mapped)
    return {
      kind: 'business_error',
      code: mapped,
      message: b.message ?? code!,
      details: { ...(b.error?.details ?? {}), ...(b.errors ? { errors: b.errors } : {}) },
    };
  if (status === 404)
    return { kind: 'business_error', code: 'PLAN_NOT_FOUND', message: b.message ?? 'Not found', details: {} };
  if (status === 423)
    return { kind: 'business_error', code: 'PERIOD_LOCKED', message: b.message ?? 'Period locked', details: {} };
  return {
    kind: 'business_error',
    code: 'ERP_VALIDATION',
    message: b.message ?? `ERP ${status}`,
    details: b.error?.details ?? {},
  };
}
