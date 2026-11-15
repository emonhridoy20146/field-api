/** Error codes — keep in sync with docs/05-api-contract.md §4. */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'TOKEN_EXPIRED'
  | 'INVALID_CREDENTIALS'
  | 'REFRESH_REUSED'
  | 'FORBIDDEN'
  | 'FEATURE_DISABLED'
  | 'DEVICE_NOT_APPROVED'
  | 'PASSWORD_CHANGE_REQUIRED'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_MISMATCH'
  | 'INVALID_STATE'
  | 'DUPLICATE_RECEIPT_NO'
  | 'CURSOR_EXPIRED'
  | 'PRECONDITION_FAILED'
  | 'PAYLOAD_TOO_LARGE'
  | 'OFF_DUTY'
  | 'BUSINESS_RULE'
  | 'ACCOUNT_LOCKED'
  | 'UPGRADE_REQUIRED'
  | 'RATE_LIMITED'
  | 'ERP_UNAVAILABLE'
  | 'INTERNAL';

const titles: Record<ErrorCode, { en: string; bn: string }> = {
  VALIDATION_FAILED: { en: 'Validation failed', bn: 'তথ্য সঠিক নয়' },
  UNAUTHENTICATED: { en: 'Authentication required', bn: 'লগইন প্রয়োজন' },
  TOKEN_EXPIRED: { en: 'Access token expired', bn: 'সেশনের মেয়াদ শেষ' },
  INVALID_CREDENTIALS: { en: 'Invalid phone/username or password', bn: 'ফোন/ইউজারনেম বা পাসওয়ার্ড ভুল' },
  REFRESH_REUSED: { en: 'Session revoked, please log in again', bn: 'সেশন বাতিল হয়েছে, আবার লগইন করুন' },
  FORBIDDEN: { en: 'You do not have permission for this action', bn: 'এই কাজের অনুমতি নেই' },
  FEATURE_DISABLED: { en: 'This feature is disabled', bn: 'এই ফিচারটি বন্ধ আছে' },
  DEVICE_NOT_APPROVED: { en: 'Device waiting for manager approval', bn: 'ডিভাইসটি ম্যানেজারের অনুমোদনের অপেক্ষায়' },
  PASSWORD_CHANGE_REQUIRED: { en: 'Password change required', bn: 'পাসওয়ার্ড পরিবর্তন করতে হবে' },
  NOT_FOUND: { en: 'Not found', bn: 'পাওয়া যায়নি' },
  IDEMPOTENCY_MISMATCH: { en: 'Idempotency key reused with different payload', bn: 'একই কী ভিন্ন তথ্যে ব্যবহার হয়েছে' },
  INVALID_STATE: { en: 'Action not allowed in the current state', bn: 'বর্তমান অবস্থায় এই কাজ করা যাবে না' },
  DUPLICATE_RECEIPT_NO: { en: 'Receipt number already used', bn: 'রসিদ নম্বর আগে ব্যবহার হয়েছে' },
  CURSOR_EXPIRED: { en: 'Sync cursor expired, full resync required', bn: 'পুরো সিঙ্ক প্রয়োজন' },
  PRECONDITION_FAILED: { en: 'Resource changed, reload and retry', bn: 'তথ্য পরিবর্তিত হয়েছে, আবার লোড করুন' },
  PAYLOAD_TOO_LARGE: { en: 'Payload too large', bn: 'ডেটা অনেক বড়' },
  OFF_DUTY: { en: 'Outside duty hours', bn: 'ডিউটির সময়ের বাইরে' },
  BUSINESS_RULE: { en: 'Business rule violated', bn: 'নিয়ম অনুযায়ী অনুমোদিত নয়' },
  ACCOUNT_LOCKED: { en: 'Account temporarily locked', bn: 'অ্যাকাউন্ট সাময়িকভাবে লক' },
  UPGRADE_REQUIRED: { en: 'App update required', bn: 'অ্যাপ আপডেট করুন' },
  RATE_LIMITED: { en: 'Too many requests', bn: 'অনেক বেশি অনুরোধ' },
  ERP_UNAVAILABLE: { en: 'ERP is unavailable', bn: 'ERP এখন পাওয়া যাচ্ছে না' },
  INTERNAL: { en: 'Internal error', bn: 'অভ্যন্তরীণ ত্রুটি' },
};

const defaultStatus: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  INVALID_CREDENTIALS: 401,
  REFRESH_REUSED: 401,
  FORBIDDEN: 403,
  FEATURE_DISABLED: 403,
  DEVICE_NOT_APPROVED: 403,
  PASSWORD_CHANGE_REQUIRED: 403,
  NOT_FOUND: 404,
  IDEMPOTENCY_MISMATCH: 409,
  INVALID_STATE: 409,
  DUPLICATE_RECEIPT_NO: 409,
  CURSOR_EXPIRED: 410,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  OFF_DUTY: 422,
  BUSINESS_RULE: 422,
  ACCOUNT_LOCKED: 423,
  UPGRADE_REQUIRED: 426,
  RATE_LIMITED: 429,
  ERP_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: ErrorCode, details?: Record<string, unknown>, opts?: { status?: number; message?: string }) {
    super(opts?.message ?? titles[code].en);
    this.code = code;
    this.status = opts?.status ?? defaultStatus[code];
    this.details = details;
  }
}

export const notFound = (entity?: string) => new AppError('NOT_FOUND', entity ? { entity } : undefined);
export const forbidden = (permission?: string) => new AppError('FORBIDDEN', permission ? { permission } : undefined);
export const businessRule = (rule: string, extra?: Record<string, unknown>) =>
  new AppError('BUSINESS_RULE', { rule, ...extra });
export const invalidState = (reason: string, extra?: Record<string, unknown>) =>
  new AppError('INVALID_STATE', { reason, ...extra });

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  requestId?: string;
  details?: Record<string, unknown>;
}

export function toProblem(err: AppError, lang: 'bn' | 'en', requestId?: string): Problem {
  return {
    type: `https://errors.howlader.app/${err.code.toLowerCase().replace(/_/g, '-')}`,
    title: titles[err.code][lang],
    status: err.status,
    code: err.code,
    ...(requestId ? { requestId } : {}),
    ...(err.details ? { details: err.details } : {}),
  };
}
