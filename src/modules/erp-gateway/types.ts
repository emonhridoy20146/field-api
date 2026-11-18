/** Internal ERP types. No Laravel field names here (those live only in mappers/). */
export interface I18nName {
  bn: string;
  en: string;
}

export interface ErpBranch {
  erpBranchId: string;
  code: string;
  name: I18nName;
  district: string;
  address: string;
  lat: number | null;
  lng: number | null;
  active: boolean;
  updatedAt: string | null;
  /** ERP location type. Warehouses can hold receivables too, so they are synced as branches (ADR-033). */
  kind?: 'branch' | 'warehouse';
}

/** An ERP employee: the collector id every ERP payment needs (users.erpEmployeeId). */
export interface ErpEmployee {
  erpEmployeeId: string;
  code: string;
  name: string;
  phone: string | null;
  erpBranchIds: string[];
  active: boolean;
}

export interface ErpScheduleLine {
  seq: number;
  dueDate: string;
  amountPoisha: number;
  /** null when Laravel does not track per-line paid amounts (ASSUMPTION E-07). */
  paidPoisha: number | null;
  /** Late fee, already included in amountPoisha (1.13.0). */
  lateFeePoisha?: number;
  /** The ERP roll-forward job zeroed this line and moved its balance to a later line (1.13.0). */
  rolled?: boolean;
  // ---- 1.14.0 (ERP field API: installment_payment_allocations + write-off allocations) ----
  /** Payments that went to this line, oldest first. Absent when the ERP does not send them. */
  payments?: ErpLinePayment[];
  /** Part of paidPoisha that the office wrote off (not cash). */
  writtenOffPoisha?: number;
}

/** One payment slice on one installment line (1.14.0). */
export interface ErpLinePayment {
  erpPaymentId: string;
  receiptNo: string | null;
  date: string;
  amountPoisha: number;
}

/** What one FOS plan is in the ERP: an installment invoice or a credit (pay-later) invoice (ADR-033). */
export type ErpPlanKind = 'installment' | 'credit';
export type ErpPlanFrequency = 'monthly' | 'weekly' | 'daily' | 'custom';

export interface ErpPlanItem {
  name: string;
  model: string | null;
  qty: number;
  serials: string[];
  // ---- 1.14.0: invoice line money, as the ERP invoice page shows it ----
  unitPricePoisha?: number;
  discountPoisha?: number;
  serviceChargePoisha?: number;
  lineTotalPoisha?: number;
}

export interface ErpGuarantor {
  name: string;
  phone: string;
  phones?: string[];
  address?: string | null;
}

/** ERP customer risk snapshot (read-only signal shown next to FOS tags). */
export interface ErpRisk {
  grade: string | null;
  level: string | null;
  classification: string | null;
  overdueCount: number;
  maxDaysLate: number;
  computedAt: string | null;
}

export type ErpPlanStatus = 'active' | 'completed' | 'closed' | 'defaulted' | 'cancelled';

export interface ErpPlan {
  erpPlanId: string;
  product: string;
  saleDate: string | null;
  principalPoisha: number;
  downPaymentPoisha: number;
  totalPayablePoisha: number;
  installmentCount: number | null;
  startDate: string | null;
  /** Final due date from Laravel; null → derive max(schedule.dueDate) (ASSUMPTION E-05). */
  endDate: string | null;
  paidPoisha: number;
  outstandingPoisha: number;
  status: ErpPlanStatus;
  schedule: ErpScheduleLine[];
  // ---- 1.13.0, from the real ERP shape (all optional so older data still reads) ----
  kind?: ErpPlanKind;
  /** ERP invoice number shown to staff and on receipts (may be null for a few old invoices). */
  invoiceNo?: string | null;
  /** The ERP installment plan id; erpPlanId is the invoice id, which is what payments are posted against. */
  erpInstallmentPlanId?: string | null;
  /** Branch of the invoice (can differ from the customer's branch). */
  erpBranchId?: string | null;
  frequency?: ErpPlanFrequency | null;
  customDays?: number | null;
  items?: ErpPlanItem[];
  guarantor?: ErpGuarantor | null;
  writtenOffPoisha?: number;
  // ---- 1.14.0: the invoice header, for the invoice viewer (all optional) ----
  /** Financed part of an installment invoice (total − down payment). */
  financedPoisha?: number;
  subtotalPoisha?: number;
  /** Invoice-level discount (ERP discount_total). */
  discountPoisha?: number;
  taxPoisha?: number;
  /** Settlement discounts given with payments (count as paid in the ERP). */
  settlementDiscountPoisha?: number;
  /** Cash refunded for returns on this invoice. */
  refundedPoisha?: number;
  /** ERP invoice status as stored (draft|active|posted|cancelled|returned). */
  invoiceStatus?: string | null;
  /** ERP payment status (unpaid|partial|paid). */
  paymentStatus?: string | null;
  /** Credit sale: the one due date. */
  creditDueDate?: string | null;
  penaltyEnabled?: boolean;
  /** ERP penalty rate as stored (e.g. "0.0200"), display only. */
  penaltyRate?: string | null;
}

export type PaymentMethod = 'cash' | 'bkash' | 'nagad' | 'rocket' | 'bank_transfer' | 'other_mobile';

export interface ErpPayment {
  erpPaymentId: string;
  erpPlanId: string | null;
  date: string;
  amountPoisha: number;
  method: string;
  source: 'office' | 'field';
  receiptNo: string | null;
  idempotencyKey: string | null;
  reversed: boolean;
  reversedAt: string | null;
  // ---- 1.13.0 ----
  /** ERP payment method name, e.g. "Cash-03". */
  methodLabel?: string | null;
  collectorName?: string | null;
  collectorEmployeeId?: string | null;
  /** The ERP's down-payment advance. */
  advance?: boolean;
  /** Settlement discount given with this payment (counts as paid in the ERP). */
  discountPoisha?: number;
}

export interface ErpCustomer {
  erpCustomerId: string;
  erpBranchId: string;
  code: string;
  name: I18nName;
  phones: string[];
  guarantor: { name: string; phone: string } | null;
  address: string;
  areaCode: string | null;
  lat: number | null;
  lng: number | null;
  status: 'active' | 'inactive' | 'closed';
  updatedAt: string | null;
  plans: ErpPlan[];
  recentPayments: ErpPayment[];
  // ---- 1.13.0 ----
  detailedAddress?: string | null;
  /** How to find the house (ERP `location_instructions`). */
  directions?: string | null;
  risk?: ErpRisk | null;
  /** Where erpBranchId came from: the customer row, or the customer's latest invoice. */
  branchSource?: 'customer' | 'last_invoice' | null;
}

export interface CustomerPage {
  items: ErpCustomer[];
  nextCursor: string | null;
  serverTime: string | null;
}

export interface PostPaymentInput {
  idempotencyKey: string;
  erpCustomerId: string;
  erpPlanId: string;
  erpBranchId: string;
  amountPoisha: number;
  method: PaymentMethod;
  transactionRef: string | null;
  collectedAt: Date;
  employeeId: string | null;
  fieldReceiptNo: string;
  physicalReceiptNo: string | null;
  note: string | null;
  fieldCollectionId: string;
  geo: { lat: number; lng: number; accuracyM: number } | null;
}

export type ConflictCode =
  | 'PLAN_SETTLED'
  | 'AMOUNT_EXCEEDS_OUTSTANDING'
  | 'PLAN_NOT_FOUND'
  | 'CUSTOMER_INACTIVE'
  | 'PERIOD_LOCKED'
  | 'ERP_VALIDATION'
  // 1.13.0: rules of the real ERP (ADR-033)
  | 'PLAN_CLOSED'
  | 'DUPLICATE_SAME_DAY'
  | 'METHOD_NOT_AVAILABLE'
  | 'COLLECTOR_NOT_LINKED';

export type PostPaymentResult =
  | {
      kind: 'posted';
      erpPaymentId: string;
      receiptNo: string | null;
      postedAt: string;
      planOutstandingAfterPoisha: number | null;
      customerOutstandingAfterPoisha: number | null;
      replay: boolean;
    }
  | { kind: 'business_error'; code: ConflictCode; message: string; details: Record<string, unknown> }
  | { kind: 'transient'; error: string; retryAfterSec?: number }
  | { kind: 'fatal'; error: string; code: 'IDEMPOTENCY_MISMATCH' | 'AUTH' | 'UNKNOWN' };

export interface ErpClient {
  readonly mode: 'live' | 'mock';
  health(): Promise<{ ok: boolean; time: string | null }>;
  listBranches(): Promise<ErpBranch[]>;
  /** ERP employees, to link FOS staff to the collector id the ERP requires (1.13.0). */
  listEmployees(): Promise<ErpEmployee[]>;
  listCustomers(q: {
    erpBranchId?: string;
    updatedSince?: string | null;
    cursor?: string | null;
    pageSize?: number;
  }): Promise<CustomerPage>;
  getCustomer(erpCustomerId: string): Promise<ErpCustomer | null>;
  listPayments(erpCustomerId: string): Promise<ErpPayment[]>;
  postPayment(input: PostPaymentInput): Promise<PostPaymentResult>;
  /** Used after timeouts before retrying (erp-integration-spec v2 §4.9). */
  getPaymentByKey(key: string): Promise<Extract<PostPaymentResult, { kind: 'posted' }> | null>;
}

export class ErpUnavailableError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ErpUnavailableError';
  }
}
