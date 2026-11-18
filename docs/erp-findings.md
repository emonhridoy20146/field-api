# Howlader ERP (Laravel) — Findings for the Field Operations System

> Version 1.0 · 2026-11-18 · read-only study of `emonhridoy20146/howlader-erp` (commit `3287587`) and of a production data copy (`howlader_inventory.sql`, phpMyAdmin dump of 2026-11-15, MariaDB 10.11).
> Nothing in the ERP was changed. No real customer data appears in this document: every number below is an aggregate, every example uses invented values.
> Companion documents: [`erp-integration-spec.md`](erp-integration-spec.md) (the proposed ERP API, ready to build later) and [`erp-mapping.md`](erp-mapping.md) (field-by-field mapping to the field-api contract).

## সংক্ষেপে (বাংলা)

- ERP-তে এখন কোনো API নেই, সব রুট শুধু ওয়েব পেজের জন্য (Blade)। Sanctum বা টোকেন লগইন নেই।
- কিস্তির হিসাব রাখা হয় **ইনভয়েস** ধরে: প্রতিটি কিস্তি-বিক্রির একটা `sales_invoices` সারি, তার একটা `installment_plans` সারি, আর প্রতি কিস্তির একটা `installment_schedules` সারি। পেমেন্ট আগে ইনভয়েসে বসে, তারপর পুরোনো কিস্তি থেকে নতুনের দিকে ভাগ হয়।
- অফিস যে বাকি দেখে সেটা `sales_invoices.amount_due`। আমাদের অ্যাপও এখন এই সংখ্যাটাই দেখাবে, নিজে হিসাব করবে না।
- পেমেন্ট মুছে ফেললে ERP সারিটাই ডিলিট করে দেয় (reverse flag নেই)। শুধু audit log-এ দাগ থাকে। তাই আমাদের সিস্টেম audit log থেকে "মুছে ফেলা পেমেন্ট" পড়বে।
- একই কিস্তি-ইনভয়েসে একদিনে একটার বেশি পেমেন্ট ERP নেয় না (বিশেষ পারমিশন ছাড়া)। আমাদের অ্যাপ এটা আগেই সতর্ক করবে।
- কাস্টমারের অক্ষাংশ/দ্রাঘিমাংশ ঘর আছে, কিন্তু ৩,০৫৭ জনের মধ্যে মাত্র ৭ জনের ভরা। ১,১০১ জন কাস্টমারের ব্রাঞ্চ ফাঁকা, তখন শেষ ইনভয়েসের ব্রাঞ্চ ধরতে হবে।
- ফোন নম্বর অনেক জায়গায় এলোমেলো লেখা (দুটো নম্বর একসাথে, নামসহ, ১০ অঙ্ক)। আমাদের ম্যাপার নম্বরগুলো বের করে পরিষ্কার করবে।
- জামিনদার ইনভয়েস অনুযায়ী আলাদা, আর অনেক জামিনদার আলাদা "কাস্টমার" হিসেবেও সেভ করা (কোড `G-…`)।
- বাংলা নাম, এলাকা কোড, ব্রাঞ্চের লোকেশন ERP-তে নেই।

## 1. System overview

| Item | Finding |
|---|---|
| Stack | Laravel 13, PHP 8.4 in production (dump header), MariaDB 10.11 (XAMPP), Blade + Alpine.js |
| Routes | `routes/web.php` (292 lines) + `routes/sms.php`; **no `routes/api.php`, no Sanctum, no token auth** (`bootstrap/app.php` registers web, console, health `/up` only) |
| Auth / RBAC | Session login; custom `roles`, `permissions` (slug), `permission_role`, `role_user`; `users.role` string still present (legacy dual track); middleware `route-access`, `permission`, `active-user`; 50+ policies |
| Timezone | `APP_TIMEZONE` default `Asia/Dhaka`; DB columns are `TIMESTAMP` without a connection timezone in `config/database.php`, so MySQL uses the server's zone (Dhaka on the XAMPP host). Dates (`payment_date`, `due_date`, `invoice_date`) are `DATE` and are Dhaka business dates |
| Money | `DECIMAL(12,2)` taka everywhere; PHP rounds with `round(x, 2)` and 0.009/0.02 tolerances |
| Scheduler | `installments:roll-overdue-due` daily; `customers:recompute-risk` 02:30 |
| External | Dizicashier POS sync (1,888 of 3,057 customers came from it, codes `DZ-…`); BulkSMSBD SMS module (new in the repo, not yet in the production dump) |
| Data size (2026-11-15) | 15 locations (13 branches, 2 warehouses), 3,057 customers, 2,430 invoices, 1,274 installment plans, 5,646 schedule lines, 2,833 payments, 18 employees, 20 users |

## 2. Data model relevant to field operations

### 2.1 Branches — `locations`
`id, code (unique, ≤20), name, type enum(warehouse, branch), address, phone, manager_name, manager_user_id, is_active, allowed_payment_methods (JSON, unused), dizicashier_uuid, timestamps`.
- Only `type = branch` rows are field branches. Codes are short and mixed case (e.g. `GKH`, `CMu`); one warehouse code contains a space.
- **No latitude/longitude, no district, no Bangla name.** field-api must keep branch coordinates null (or let admins set them in FOS).
- Users ↔ branches via `location_user`; employees ↔ branches via `employee_location` (many-to-many).

### 2.2 Customers — `customers`
`id, customer_code (unique), name (≤150), phone (≤20, NOT NULL), phone_numbers (JSON array), email, address, detailed_address, location_instructions, latitude DECIMAL(10,8), longitude DECIMAL(11,8), house_image_path, location_image_path, photo_path, nid_path, attachments (JSON), id_type, id_number, branch_id (nullable), default_guarantor_id (→ customers.id), credit_limit, outstanding_balance, is_active, dizicashier_uuid, timestamps`.

| Fact | Count / note |
|---|---|
| Customers | 3,057, all `is_active = 1` |
| `branch_id` NULL | 1,101 (349 of them are installment/credit buyers) → use the branch of the customer's latest invoice (the ERP already has `AssignCustomerBranchFromLastInvoiceCommand` with the same rule) |
| Coordinates filled | 7 (all inside the Barishal area); none are `0`. The ERP has a "Customer tracking" screen (`CustomerTrackingController`, permissions `customer.tracking.view/update`) that sets lat/lng, detailed address, directions and house/location photos |
| `detailed_address` / `location_instructions` | 3 / 0 filled |
| Phone shape | 2,925 clean `01XXXXXXXXX`; 132 messy: two numbers in one field (`…, …`, `… / …`, `…-…`), brackets, `+880…`, 10 digits without the leading 0, a name with or without a number |
| `phone_numbers` JSON | mostly `[]`; 43 with extra numbers, some with text like a relation word before the number |
| Bangla names | none (0 names contain Bangla letters) |
| Codes | `DZ-…` (Dizicashier import), `CUS…` (native), `G-…` (guarantors saved as customers, 198) |
| Buyers | 1,441 customers have at least one installment or credit invoice; 589 owe money today |
| `outstanding_balance` | maintained by increments/decrements; matches the sum of open invoice dues for all but 16 customers. Treat as informational only |

### 2.3 Receivables — `sales_invoices` (+ `sales_invoice_lines`, `sale_line_serials`)
Key columns: `id, invoice_number (nullable until first payment for some flows), invoice_date, branch_id, customer_id, sale_type enum(default, credit, installment), status enum(draft, active, posted, cancelled, returned), payment_status enum(unpaid, partial, paid), grand_total, amount_paid, amount_due, discount_total, credit_due_date, installment_down_payment, installment_count, installment_first_due_date, installment_frequency (monthly|weekly|daily|custom), installment_custom_days, installment_penalty_enabled, installment_penalty_rate, guarantor_id, guarantor_name, guarantor_address, guarantor_phone_numbers (JSON), guarantor_notes, guarantor_nid_number, referrer_id (→ employees), deleted_at (soft delete)`.

| sale_type | status in use | collectable by field staff? |
|---|---|---|
| `installment` | `active` (posted installment sale), `returned` | **Yes** while `status = active` and `amount_due > 0` (525 invoices, ≈ 53.8 lakh taka) |
| `credit` | `posted`, `returned` | **Yes** while `status = posted` and `amount_due > 0` (68 invoices, ≈ 5.5 lakh); one due date `credit_due_date` |
| `default` (cash sale) | `posted`, `draft`, `returned` | **No** — `requiresFullPaymentOnCollection()`; only 5 posted cash sales have a balance |

- Number formats: `INV-NNNNN` (native), `S-YY…` (Dizicashier), some `NULL` (a few drafts).
- Lines: 1 line for 89 % of installment invoices, up to 8. Product name and model from `products (name, model_number)`; serial numbers via `sale_line_serials → serial_items.serial_number` (351 serials on installment lines).
- Returned invoices: `status = returned` (6 installment invoices still have an `active` plan and a due). Treat them as **closed** for collection.
- Write-offs: `invoice_debt_writeoffs` (243 rows, ≈ 6.2 lakh): reduce `amount_due`, raise schedule `paid_amount` by waterfall (`installment_writeoff_allocations`).

### 2.4 Installment plans — `installment_plans`, `installment_schedules`
- Exactly **one plan per installment invoice** (1,274 plans for 1,274 invoices). Created when the invoice is activated (`ActiveInstallmentInvoiceRevisionService`).
- Plan: `total_amount (= grand_total), down_payment, financed_amount (= grand_total − down payment), remaining_amount, penalty_enabled, penalty_rate, reschedule_count, status enum(active, completed, defaulted, cancelled)` — in the data only `active` (529) and `completed` (745).
- Schedule line: `installment_no, due_date, due_amount, paid_amount, late_fee_amount, status enum(pending, partially_paid, paid, overdue, rescheduled)`.
  - Generated as `round(financed / count, 2)` per line, rounding delta on the last line; due dates from `installment_first_due_date` + offset by frequency (month / week / day / custom days). Mostly monthly (1,268), weekly 3, daily 3. Counts 1–30 (mostly 3, 5 or 6).
  - **Per-line paid amounts are stored** (ASSUMPTION E-07 resolved: yes).
  - **The stored `status` is stale**: 264 lines say `pending` but are past due with a balance. Compute status the ERP way: `remaining = due + late_fee − paid`; paid if `remaining < 0.009`, partially_paid if `paid > 0.009`, overdue if `due_date < today`, else pending (`InstallmentSchedule::computeStatus`).
  - Late fees: column exists, all 0 today; penalty enabled on 1 plan. Include late fee in the line amount.
- **Roll-forward** (`InstallmentOverdueRollForwardService`, daily): an unpaid past-due line is zeroed (`due_amount = paid_amount`) and its balance is added to the next line, so missed dues pile up on later lines. 493 lines have `due = paid = 0` (rolled). The data also has 563 past-due open lines that are not the last line, so the roll job has not run every day. Consequence: never infer "missed installments" from line count; use the ERP's own definition — **overdue = sum of `remaining` on lines with `due_date < today`** (same as `ReportDataService::installmentOverdueBaseQuery`), and show zero-amount lines as "moved to a later installment".
- Final due date = due date of the last line (`SalesInvoice::finalInstallmentDueDate()`); there is no end-date column (E-05 resolved).
- `installment_reschedules` keeps a JSON snapshot for manual reschedules (none in use).

### 2.5 Payments — `payments`, `payment_allocations`, `installment_payment_allocations`
- `payments`: `id, payment_number (PAY-YYYYMMDD-NNNNN inbound, REF-… refunds), customer_id, payment_date (DATE), payment_method enum(cash, card, bank_transfer, mobile_money, bank, credit, installment), payment_method_id (→ payment_methods), wallet_id, amount, direction (inbound|outbound), reference_no (≤100), notes, recorded_by (→ users), referrer_employee_id (→ employees), timestamps`.
- Every inbound payment has **exactly one** `payment_allocations` row (→ `sales_invoice_id`, `allocated_amount`, `settlement_discount`). 17 outbound refund payments have none.
- Installment invoices: the allocation is spread over schedule lines in `installment_payment_allocations` — **waterfall oldest-first** by default, or one chosen line (`installment_target = schedule`), or "advance" (down payment, `reference_no = 'Installment advance payment'`, 290 payments).
- `settlement_discount` (51 allocations, ≈ 48 k): a discount given at payment time; it counts toward `amount_paid`.
- **Collector**: `referrer_employee_id` is required by the office form (`StoreInvoiceInboundPaymentRequest`); 14 distinct collectors. `reference_no` is in practice the collector's **name typed by the office** (e.g. "<name> …"), except the advance marker. `recorded_by` = the user who typed it.
- **Rules in `PaymentService::recordAndAllocate`** (the only correct way to create a payment):
  1. Invoice locked `FOR UPDATE`; amount must be > 0.
  2. Overpayment is rejected (`OverpaymentException`, amount + discount > `amount_due`) unless the internal flag `allow_flexible_collection` is set (admin-only flow). → E-20 resolved: **no advances beyond the due**.
  3. Cash (`default`) sales must be paid in full.
  4. **One inbound payment per day per installment invoice**, unless the acting user has permission `installment.allow-same-day-duplicate` (14 invoice-days already have two payments).
  5. Payment method is required for cash collection; the wallet is resolved from `payment_method_wallet (location_id, payment_method_id, wallet_id)` for the invoice branch; GL journal posted (`JournalService::postCustomerPaymentGl`).
  6. AR ledger row (`accounts_receivable_ledger`), customer `outstanding_balance` decremented, schedules updated, plan totals refreshed, invoice header synced, invoice number assigned if missing, audit log written — all in one DB transaction.
- **Date window**: the office form allows `payment_date ≤ today` and, without permission `sales.invoice.backdate`, `≥ today − 2 days`. `PaymentService` itself has no date check. 732 of 2,833 payments were entered more than 2 days after their payment date (historical entry).
- **Reversal = hard delete**: `removeAllocationFromInvoice()` deletes the allocation, the installment slices, the journals, the AR ledger row and the payment row, and writes audit `sales_invoice.payment_removed` with `before_snapshot.payment_number / allocation_cash` and `after_snapshot.payment_id_removed` (252 removals so far). There is no "reversed" flag (E-17 changed).
- No accounting period lock exists (E-21: no). No idempotency key column exists.
- Payment methods in production: 8 rows `Cash-01 … Cash-8`, all `type = cash`, each mapped to one branch wallet. Types supported by the code: `cash, bank, card_terminal, mobile_banking` (with `mobile_provider`, `mobile_number`). **No bKash/Nagad method exists yet** (E-18 changed): a field bKash payment needs the office to add a `mobile_banking` method mapped to the branch wallet first.

### 2.6 Guarantors
- Per invoice: `guarantor_id` (→ customers, 191 invoices) and/or free fields `guarantor_name` (1,201), `guarantor_phone_numbers` (1,185), `guarantor_address`, `guarantor_nid_number` (20).
- Per customer: `default_guarantor_id` (70 customers), copied into new installment invoices.
- Display rule used by the ERP collection reports (`SalesInvoice::collectionGuarantorDisplayParts`): invoice guarantor first (if it is not the buyer), else the customer's default guarantor.
- NID numbers and NID images exist; **never expose them to field staff**.

### 2.7 Employees and users
- `employees`: `id, employee_code (EMP-NNNNN), user_id (nullable), first_name, last_name, phone, employment_status, is_active, check_in_time, check_out_time, hr_department_id, hr_designation_id, …`; 18 rows, 6 linked to a user. Branches via `employee_location`.
- `users`: `id, name, full_name, email, phone, role (legacy string), branch_id, is_active, last_login_at`; roles Administrator, Staff, Branch Manager, Accountant, Sales, Warehouse, Area Manager.
- field-api `users.erpEmployeeId` should hold `employees.id`; it is **required** to post a payment the way the office does.

### 2.8 Other modules worth knowing
- **Customer risk** (`CustomerRiskService`, `customer_risk_snapshots`): grade A–E (+N/A), level Low/Medium/High, classification none/isolated/trend, overdue counts, days late. Only 15 snapshots stored (computed on demand). Useful as an extra signal next to FOS tags.
- **Attendance, leave, salary** (HR): office attendance (`attendance_records`, 1,290 rows), leave types/requests. Separate from FOS attendance; no sync planned.
- **Branch sales targets** (annual/monthly): sales targets, not collection targets. Separate from FOS daily targets.
- **Returns** (`return_orders`, `return_lines`): approve → restock/refund; marks invoices `returned`. Natural home for the future "product return / repossession" workflow (missing-features item 9).
- **SMS** (BulkSMSBD, `sms_templates/batches/messages`, manual send only, admins): the gateway our SMS receipt/reminder ideas (OD-06) could reuse later.

## 3. Assumption register — verified against the code and data

| ID | Was | Now | Status |
|---|---|---|---|
| E-01 | Customer entity with id + branch id | `customers.id` (bigint); `branch_id` nullable → fallback latest invoice branch | **verified, changed** |
| E-02 | lat/lng as two columns | `customers.latitude/longitude` DECIMAL(10,8)/(11,8) | verified |
| E-03 | Coordinates may be junk | NULL when unknown (no zeros seen); only 7 filled | verified |
| E-04 | Several active plans per customer | Yes (2 customers have 2 active plans now; plus credit invoices) | verified |
| E-05 | Plan end date | No column; last schedule line due date | verified (use max due date) |
| E-06 | Outstanding by Laravel's logic | `sales_invoices.amount_due` — the number the payment form checks against | verified |
| E-07 | Per-line paid amounts may be missing | Stored (`installment_schedules.paid_amount`), but `status` is stale | verified, changed |
| E-08 | DECIMAL(…,2) BDT | DECIMAL(12,2) | verified |
| E-09 | Asia/Dhaka | `APP_TIMEZONE=Asia/Dhaka`; DATE columns are Dhaka dates | verified |
| E-10 | Stable branch ids | `locations.id`; filter `type = branch` | verified |
| E-11 | Area/route code | **None** | changed — areas come from FOS polygons/manual assignment only |
| E-12 | Cursor pagination | No API yet; the prototype pages by customer id with an opaque cursor and filters by `updated_since` over `changed_at` | resolved in the prototype |
| E-13 | `updated_at` touched on change | Mostly (invoice ≥ last payment for 1,223/1,256); removals leave no row | changed — API computes `changed_at` over related rows + audit log |
| E-14 | Coordinates write-back acceptable | The ERP already edits them (Customer tracking screen) | likely yes — owner to confirm |
| E-15 | Defaulter flag | No flag; risk grade instead | changed |
| E-16 | Employees usable as collector id | `employees.id` = `payments.referrer_employee_id`, required | verified |
| E-17 | Reversal process with audit | Hard delete + audit log row | changed |
| E-18 | Methods incl. bKash/Nagad | Only cash methods configured; `mobile_banking` type supported | changed |
| E-19 | ERP receipt numbering | `payment_number` `PAY-YYYYMMDD-NNNNN` (global daily sequence) | verified |
| E-20 | Advances accepted | No; overpayment rejected; one payment per day per installment invoice | changed |
| E-21 | Accounting period lock | None; office form allows 2 days back | changed |
| E-22 | Roles/permissions model | Custom tables with slugs | verified |
| E-23 | Sanctum | Not installed | changed — API must add token auth (additive) |
| E-24 | Phone format `01XXXXXXXXX` | 96 % clean, 4 % messy text | changed — mapper normalizes |
| E-25 | Bangla name stored | No | changed — `name.bn = name.en` until FOS stores one |
| E-26 | Read load ~1 rps OK | Small data (3 k customers); one full read ≈ 1,441 buyers | likely fine |

## 4. What this means for our three apps (all built in field-api contract 1.13.0)

| Topic | Decision in our apps |
|---|---|
| What is a "plan" in FOS | One collectable ERP **invoice** (installment or credit). `erpPlanId` = `sales_invoices.id`; the ERP installment plan id is kept as `erpInstallmentPlanId`. Payments in the ERP are recorded against the invoice, so this is the id the API needs |
| Outstanding | `amount_due` of the invoice. Customer total = sum of collectable invoices |
| Schedule | ERP lines with `amount = due + late fee`, `paid` from the ERP, status computed on the Dhaka date. Zero-amount (rolled) lines are kept but marked `rolled` and hidden by the apps |
| Credit sales | One line on `credit_due_date` |
| Closed plans | `returned`, `cancelled`, soft-deleted → not collectable; completed when `amount_due = 0` |
| Product | Line items (name, model, qty, serials) shown on the plan; `product` = joined names |
| Guarantor | Per plan (invoice guarantor, else customer default); customer-level guarantor = the one on the most recent open plan |
| Phones | Mapper extracts every Bangladeshi mobile number from `phone` and `phone_numbers`, normalizes to `01XXXXXXXXX`, de-duplicates |
| Branch | `customers.branch_id`, else latest invoice branch; plan carries its own invoice branch |
| Coordinates | ERP lat/lng used when present; FOS pins remain the main source (only 7 in the ERP) |
| Directions | `detailed_address` and `location_instructions` shown to staff |
| Payment history | ERP payments with receipt number, method name, collector name; removed payments come from the audit log and are shown as reversed |
| Posting a field collection | Must name an ERP employee (`users.erpEmployeeId`), a method type available at the branch, and land at most once per invoice per day |
| New conflicts | `DUPLICATE_SAME_DAY` (ERP already has a payment today for that installment invoice), `METHOD_NOT_AVAILABLE` (no ERP payment method of that type at the branch), `COLLECTOR_NOT_LINKED` (staff user has no ERP employee), `PLAN_CLOSED` (returned/cancelled invoice) |
| ERP risk | Grade and level shown next to the FOS tag (read-only) |
| Branch map point | Not in the ERP; set in FOS with `PUT /branches/{id}/location` (ERP sync never clears it) |
| Linking staff | Admin picks the ERP employee for each staff user from `GET /system/erp-employees` |
| Warehouses | Synced as branches so their 26 customers are not lost |

## 5. Risks and recommendations for the ERP side (later, owner's call)

1. **Build the API as additive files only** (own service provider, route file, middleware with a hashed bearer token, controllers under `App\Http\Controllers\Api\Field`, one `field_payment_requests` table; no Sanctum needed). No change to existing tables or services; one line in `bootstrap/providers.php`. Already written and tested on a sandbox copy: see the spec and `erp-api-prototype/`.
2. **Integration user** with role "Field Integration": permission `payment.create` only (reads go through the API itself). Decide whether it gets `installment.allow-same-day-duplicate` (default: no — open decision OD-27).
3. **bKash/Nagad**: add `mobile_banking` payment methods mapped to each branch wallet before enabling those methods in the field app (otherwise `METHOD_NOT_AVAILABLE`).
4. **Link employees**: every field staff member must exist in `employees` (and in `employee_location` for their branch); copy `employees.id` into the FOS user (`erpEmployeeId`).
5. **Roll-forward job**: it did not run every day (563 past-due lines not rolled). Not a problem for FOS (we compute overdue the same way the ERP report does), but the office should know.
6. **Stale schedule status**: the stored status drifts; any report reading `status` directly is wrong for 264 lines. FOS ignores the stored value.
7. **Timezone**: keep MySQL session timezone = Asia/Dhaka (or set `DB_TIMEZONE`) if the ERP ever moves to a UTC server, otherwise TIMESTAMP values shift by 6 hours.
8. **Phones**: a data-cleaning pass in the ERP (one number per field) would help every system; FOS copes either way.
9. **Branch on customer**: running the existing `AssignCustomerBranchFromLastInvoiceCommand` would fill 1,101 empty branches; FOS uses the same fallback meanwhile.
10. **Branch codes and warehouses**: two branch codes are one letter (`H`, `U`) and 35 receivable invoices sit on warehouse locations. FOS copes (receipt codes are sanitized, warehouses are synced as branches), but the office may want to move those invoices to a branch.
11. **Down payment not on the schedule**: in 12 active installment invoices the down payment is still unpaid and is not a schedule line, so it never shows as overdue in the ERP's overdue report either.

## 6. How this was checked
- Code read: models, migrations, `PaymentService`, `InstallmentInvoiceSyncService`, `InstallmentOverdueRollForwardService`, `InstallmentAdvanceService`, `ActiveInstallmentInvoiceRevisionService`, `DebtWriteoffService`, `CustomerRiskService`, `ReportDataService` (overdue queries), payment requests and controllers, scheduler.
- Data: the dump was loaded into a private MariaDB 10.11 inside the cloud sandbox only; all statistics are SQL aggregates. The dump is not stored in any repository.
