# ERP → Field Operations mapping (contract 1.13.0)

Every field the ERP field API v1 sends ([`erp-integration-spec.md`](erp-integration-spec.md)), what field-api makes of it, and where the apps show it.
Laravel names appear in field-api **only** in `src/modules/erp-gateway/mappers/laravel-v1.ts` and the test fixtures (`test/fixtures/erp/v1/`).

> **সংক্ষেপে:** ERP-এর একটা ইনভয়েস (কিস্তি বা বাকিতে বিক্রি) = আমাদের একটা "plan"। টাকা ERP-তে দশমিক স্ট্রিং, আমাদের কাছে পয়সা (পূর্ণসংখ্যা)। কিস্তির লাইনে লেট ফি যোগ হয়ে দেখায়; ERP যেসব লাইন পরের কিস্তিতে সরিয়ে দিয়েছে সেগুলো লুকানো থাকে। অফিস পেমেন্ট মুছে দিলে আমাদের কাছে "বাতিল" দেখায়।

Legend: **I** = internal type in field-api (`erp-gateway/types.ts`), **API** = field-api contract (`openapi.yaml`), **web** = admin-web, **app** = staff-app.

## 1. Branch (`GET /branches?type=all`)

| ERP | I (`ErpBranch`) | API (`Branch`) | Notes |
|---|---|---|---|
| `id` | `erpBranchId` | `erpBranchId` | |
| `code` | `code` (trimmed) | `code` | Mixed case and 1-letter codes exist (`CMu`, `H`). Receipt numbers use `receiptBranchCode()`: upper case, A–Z/0–9 only, max 10 |
| `name` | `name.en` and `name.bn` | `name` | No Bangla name in the ERP |
| `type` | `kind` (`branch` / `warehouse`) | `Branch.kind` (1.13.0) | Warehouses are synced too: 35 receivable invoices (26 customers) sit on one |
| `address` | `address` | `address` | |
| `phone`, `manager_name` | — | — | Not used |
| `is_active` | `active` | `active` | |
| — | `district` = `''`, `lat/lng` = `null` | `district`, `lat`, `lng` | Not in the ERP. Admins set the map point in FOS: `PUT /branches/{id}/location` (new in 1.13.0); ERP sync never clears it |

## 2. Employee (`GET /employees`)

| ERP | I (`ErpEmployee`) | API (`GET /system/erp-employees`) | Notes |
|---|---|---|---|
| `id` | `erpEmployeeId` | `erpEmployeeId` | Stored on the FOS user as `erpEmployeeId`; sent as `collector_employee_id` on every payment |
| `employee_code`, `name` | `code`, `name` | same | Admin picks the employee in the user form |
| `branch_ids` | `erpBranchIds` | same | |
| `is_active` (+ `employment_status = active`) | `active` | `active` | An inactive collector → `COLLECTOR_NOT_LINKED` |
| `phone`, `user_id` | `phone` (normalized) / — | — | Not exposed |

## 3. Customer (`GET /customers`)

| ERP | I (`ErpCustomer`) | API (`CustomerDetail`) | web / app |
|---|---|---|---|
| `id` | `erpCustomerId` | `erpCustomerId` | |
| `customer_code` | `code` | `code` | Shown everywhere |
| `name` | `name.en = name.bn` | `name` | No Bangla names in the ERP |
| `phone`, `phone_numbers[]` | `phones[]`: every BD mobile found, normalized to `01XXXXXXXXX`, de-duplicated; when none is valid the raw text is kept | `phone` (first), `phones` | Call buttons. Real data: 1,399 of 1,441 buyers have a valid mobile, 40 keep raw text |
| `branch_id` (+ fallback to latest invoice) | `erpBranchId` | `branchId` (FOS id) | Customers with no branch at all are skipped with a log line (none today) |
| `branch_source` | `branchSource` | — | Diagnostics |
| `address` | `address` | `address` | |
| `detailed_address` | `detailedAddress` | `detailedAddress` (1.13.0) | Customer detail, both apps |
| `location_instructions` | `directions` | `directions` (1.13.0) | "How to find the house", both apps |
| `latitude`, `longitude` | `lat`, `lng` (number or null) | `location` | FOS pins stay the main source (only 7 in the ERP) |
| `is_active` | `status` `active` / `inactive` | — | Inactive → `CUSTOMER_INACTIVE` conflict on posting |
| `outstanding_balance` | — | — | Ignored (drifts for 16 customers); FOS total = sum of collectable invoice dues |
| `default_guarantor` | fallback for `guarantor` | `guarantor` | |
| `risk.{grade, risk_level, classification, overdue_count, max_days_late, computed_at}` | `risk` | `erpRisk` (1.13.0) | Badge next to the FOS tag, read-only |
| `changed_at` (else `updated_at`) | `updatedAt` | — | Delta-sync and cache age |
| `invoices[]` | `plans[]` | `plans[]` | §4 |
| `recent_payments[]` + `removed_payments[]` | `recentPayments[]` | `payments[]` | §5 |
| — | `areaCode = null` | — | The ERP has no area/route code; FOS areas come from polygons or manual assignment |

Customer-level `guarantor` = the guarantor of the newest open plan, else the customer's default guarantor. NID numbers and images are never sent.

## 4. Invoice → Plan

| ERP | I (`ErpPlan`) | API (`Plan`) | web / app |
|---|---|---|---|
| `id` | `erpPlanId` | `erpPlanId` | Payments are posted against it (`sales_invoice_id`) |
| `invoice_number` | `invoiceNo` | `invoiceNo` (1.13.0) | Plan header, receipt |
| `invoice_date` | `saleDate` | `saleDate` (1.13.0) | |
| `branch_id` | `erpBranchId` | — | The ERP picks the payment method of this branch |
| `sale_type` | `kind` `installment` / `credit` | `kind` (1.13.0) | "Credit sale" label |
| `status`, `amount_due`, `collectable`, plan `status` | `status`: `cancelled` ← cancelled; `closed` ← returned/draft/not receivable; `completed` ← due 0; `defaulted` ← plan defaulted; else `active` | `status` | Closed/cancelled are hidden from collection and not counted in totals |
| `grand_total` | `totalPayablePoisha` | `totalPayablePoisha` | |
| `amount_paid` | `paidPoisha` | `paidPoisha` | Includes the down-payment advance and settlement discounts |
| `amount_due` | `outstandingPoisha` | `outstandingPoisha` | **The** collectable number |
| `written_off` | `writtenOffPoisha` | `writtenOffPoisha` (1.13.0) | "Written off" line when > 0 |
| `items[].{name, model_number, qty, serials}` | `items[]`, `product` = "name model ×qty, …" | `items` (1.13.0), `product` | Product list with serials |
| `guarantor` | `guarantor {name, phone, phones, address}` | `Plan.guarantor` (1.13.0) | Call guarantor |
| `installment_plan.id` | `erpInstallmentPlanId` | — | Reference only |
| `installment_plan.down_payment` | `downPaymentPoisha` | `downPaymentPoisha` | |
| `installment_plan.financed_amount` | `principalPoisha` | — | |
| `installment_plan.frequency`, `custom_days` | `frequency`, `customDays` | same (1.13.0) | "Monthly / weekly / every N days" |
| `installment_plan.installment_count` | `installmentCount` | `installmentCount` | |
| first / last line `due_date` | `startDate` / `endDate` | `startDate` / `finalDueDate` | No end-date column: the last line is the final due date |
| `credit_due_date` (credit) | one line: amount = paid + due + written off, paid = paid + written off | `schedule[0]` | |

### 4.1 Schedule line

| ERP (`installment_plan.schedules[]`) | I (`ErpScheduleLine`) | API (`Plan.schedule[]`) | Notes |
|---|---|---|---|
| `installment_no` | `seq` | `seq` | |
| `due_date` | `dueDate` | `dueDate` | Dhaka date |
| `due_amount + late_fee_amount` | `amountPoisha` | `amountPoisha` | |
| `late_fee_amount` | `lateFeePoisha` | `lateFeePoisha` (1.13.0) | All 0 today; shown when > 0 |
| `paid_amount` | `paidPoisha` | `paidPoisha` | |
| `due = paid = fee = 0` | `rolled = true` | `rolled` (1.13.0) | Moved to a later line by the ERP's roll-forward job; apps hide it (493 such lines) |
| `status` | — | `status` computed by FOS | The stored ERP status is stale; FOS computes paid/partial/due/overdue/upcoming on the Dhaka date |
| `remaining_amount` | — | `outstanding` derived | |

Overdue = unpaid amount on lines due before today, the same definition as the ERP's overdue report. Known data effect: in 23 active invoices the lines do not add up to the invoice due (12 of them because the down payment is still unpaid; ≈ 1 lakh taka in total). FOS shows the invoice due as outstanding and the lines as they are.

## 5. Payments

| ERP (`recent_payments[]`) | I (`ErpPayment`) | API (`Payment`) | Notes |
|---|---|---|---|
| `id` | `erpPaymentId` | `erpPaymentId` | |
| `payment_number` | `receiptNo` | `receiptNo` | `PAY-YYYYMMDD-NNNNN` |
| `sales_invoice_id` | `erpPlanId` | `erpPlanId` (1.13.0) | |
| `payment_date` | `date` | `date` | |
| `amount` | `amountPoisha` | `amountPoisha` | |
| `settlement_discount` | `discountPoisha` | `discountPoisha` (1.13.0) | |
| `payment_method_type` (else `payment_method`) | `method`: cash → `cash`, mobile_banking → `other_mobile`, bank → `bank_transfer`, card_terminal → `card` | `method` | |
| `payment_method_name` | `methodLabel` | `methodLabel` (1.13.0) | e.g. "Cash-03" |
| `collector_employee_id`, `collector_name` | `collectorEmployeeId`, `collectorName` | `collectorName` (1.13.0) | |
| `is_advance` | `advance` | `advance` (1.13.0) | Down-payment advance (not counted for the same-day rule) |
| `source` (`field_app` / `office`) | `source` `field` / `office` | `source` | |
| `idempotency_key` | `idempotencyKey` | — | Matches the ERP payment to the FOS collection |
| `removed_payments[]` | a payment with `reversed = true`, `reversedAt = removed_at`, date = `payment_date` ?? date in `payment_number` ?? Dhaka date of `removed_at` | `reversed` | The collection shows "reversed in ERP" |

## 6. Posting a collection (`POST /payments`)

| FOS collection | ERP request | Notes |
|---|---|---|
| `Idempotency-Key` header = the collection's key | `Idempotency-Key` | Never regenerated on retry |
| `erpPlanId` | `sales_invoice_id` | |
| customer's `erpCustomerId` | `customer_id` | |
| `amountPoisha` | `amount` ("5000.00") | |
| `recordedAt` | `collected_at` (+06:00) | ERP `payment_date` = its Dhaka date |
| `method` cash / bkash / nagad / rocket / other_mobile / bank_transfer | `method_type` cash / mobile_banking / bank, `mobile_provider` bkash / nagad / rocket | The ERP picks the branch method of that type (and provider) |
| collector's `erpEmployeeId` | `collector_employee_id` | Missing → `COLLECTOR_NOT_LINKED` without calling the ERP |
| `transactionRef` | `transaction_ref` | |
| `receiptNo` | `field_receipt_no` | |
| collection id | `field_collection_id` | |
| `physicalReceiptNo`, `note` | `note` ("Book receipt … · …", max 300) | |
| `geo` | — | Not sent; stays in FOS |

| ERP answer | FOS |
|---|---|
| `201` / `200` replay: `id`, `payment_number`, `posted_at`, `invoice_amount_due_after`, `customer_outstanding_after` | `posted`: `erpPaymentId`, `erpReceiptNo`, outstanding after |
| `PLAN_SETTLED`, `AMOUNT_EXCEEDS_OUTSTANDING`, `PLAN_NOT_FOUND`/`CUSTOMER_NOT_FOUND`, `CUSTOMER_INACTIVE`, `PERIOD_LOCKED` | conflict with the same code |
| `PLAN_CLOSED`, `DUPLICATE_SAME_DAY`, `METHOD_NOT_AVAILABLE`, `COLLECTOR_NOT_LINKED` (new) | conflict with the same code, bn/en text |
| `VALIDATION_FAILED`, `ERP_REJECTED` | conflict `ERP_VALIDATION` |
| `IDEMPOTENCY_MISMATCH` | posting failed (alert) |
| `401` / `403` | posting paused, admins alerted |
| `409 CONCURRENT_REQUEST`, `429`, `5xx`, timeout | retry; after a timeout field-api first asks `GET /payments/by-idempotency-key/{key}` |

## 7. Checked against the real data (sandbox copy, 2026-11-18)
field-api in live mode against the prototype API: 1,441 of 1,441 buyers synced (15 locations, 12.5 s); FOS total outstanding = ERP collectable dues to the poisha (59,38,641.66 taka); 1,462 plans (593 active, 861 completed, 8 closed, 189 credit); a field collection posted through the outbox, came back with its key on the next delta sync, a second one the same day became `DUPLICATE_SAME_DAY`, and an office removal showed up as reversed with the balance restored.
