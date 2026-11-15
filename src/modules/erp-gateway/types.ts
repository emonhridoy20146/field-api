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
}

export interface ErpScheduleLine {
  seq: number;
  dueDate: string;
  amountPoisha: number;
  /** null when Laravel does not track per-line paid amounts (ASSUMPTION E-07). */
  paidPoisha: number | null;
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
  | 'ERP_VALIDATION';

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
  listCustomers(q: { erpBranchId?: string; updatedSince?: string | null; cursor?: string | null; pageSize?: number }): Promise<CustomerPage>;
  getCustomer(erpCustomerId: string): Promise<ErpCustomer | null>;
  listPayments(erpCustomerId: string): Promise<ErpPayment[]>;
  postPayment(input: PostPaymentInput): Promise<PostPaymentResult>;
  /** Used after timeouts before retrying (erp-integration-spec §4.5). */
  getPaymentByKey(key: string): Promise<Extract<PostPaymentResult, { kind: 'posted' }> | null>;
}

export class ErpUnavailableError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ErpUnavailableError';
  }
}
