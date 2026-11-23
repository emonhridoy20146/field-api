# ERP integration spec v2 — Howlader ERP field API v1

> v2 (2026-11-18) replaces the v1 proposal of this file. Every Laravel name below was checked against the ERP code and a copy of its data ([`erp-findings.md`](erp-findings.md)). The ASSUMPTION register E-01…E-26 is resolved in [`erp-findings.md` §3](erp-findings.md#3-assumption-register--verified-against-the-code-and-data). New Laravel guesses go there as E-27 onward.

**Status:** prototype written and tested in a private sandbox copy of the ERP against a copy of the production data (2026-11-18). **Nothing is deployed and the production repository `howlader-erp` is unchanged.** The prototype code is kept outside this repository (project files, `erp-findings/erp-api-prototype/`) because the ERP repository must not change until the owner says so; it can be installed later in one short step (§8).

**Who calls it:** only field-api (the Field Operations backend). The admin panel and the staff app never call the ERP.

**Companion documents:** [`erp-findings.md`](erp-findings.md) (what the ERP is and how its data behaves) and [`erp-mapping.md`](erp-mapping.md) (every field below → field-api → apps).

> **সংক্ষেপে:** ERP-তে একটা আলাদা, নতুন API মডিউল — শুধু নতুন ফাইল, পুরনো কোনো টেবিল বা সার্ভিস বদলায় না (একটা লাইন ছাড়া: provider রেজিস্টার)। `.env`-এ চালু না করলে সব রুট 404 দেয়। পেমেন্ট ঢোকে ERP-এর নিজস্ব `PaymentService` দিয়ে, তাই অফিসের ফর্মের সব নিয়ম (বেশি টাকা না, দিনে একবার, মেথড/ওয়ালেট) একই থাকে। একই Idempotency-Key দিয়ে দুবার পাঠালে দ্বিতীয়বার নতুন পেমেন্ট হয় না।

---

## 1. Principles

1. **Additive only.** New files: one config, one service provider, one middleware, one route file, three controllers, three service classes, one model, one migration (new table `field_payment_requests`), one artisan command, one test file. The only edit to an existing file is one line in `bootstrap/providers.php`. No existing table, column, service or route changes.
2. **Off by default.** Every route answers `404` until `FIELD_API_ENABLED=true`. Turning it off again is the rollback.
3. **Read + one write.** Reads: branches, employees, payment methods, customers with their receivables. Write: record a customer payment against an invoice. Nothing else (no customer edits, no coordinate write-back in v1).
4. **The ERP's own rules decide.** A payment is created only through `PaymentService::recordAndAllocate()` (the same call the office "Receive payment" form makes). Overpayment, one-payment-per-day, method/wallet, journals, AR ledger, schedule waterfall and audit log all behave exactly as for an office payment.
5. **Idempotent.** Each payment carries the field app's `Idempotency-Key`. A repeat returns the first result; nothing is posted twice.
6. **Privacy.** Never returns NID numbers, NID/house/location/photo images, email, credit limit or attachments.
7. **Money** is a decimal string with two places (`"1250.00"`), exactly as stored (`DECIMAL(12,2)`). **Dates** (`YYYY-MM-DD`) are Asia/Dhaka business dates. **Timestamps** are ISO 8601 with offset (`2026-11-18T11:05:00+06:00`).

## 2. Authentication and the integration user

| Item | Value |
|---|---|
| Scheme | `Authorization: Bearer <token>` (48 random characters) |
| Stored | Only the token's SHA-256 in `.env` (`FIELD_API_TOKEN_SHA256`). A second slot `FIELD_API_TOKEN_NEXT_SHA256` allows rotation without downtime (field-api also has `ERP_API_TOKEN_NEXT`) |
| Acting user | `FIELD_API_USER_ID` → a dedicated `users` row "Field Integration", **not an admin** (admins bypass the one-payment-per-day rule). Logged in for the request only (`Auth::onceUsingId`), so audit logs and `payments.recorded_by` show this user |
| Role | `field_integration` with permission `payment.create`. Optional `installment.allow-same-day-duplicate` (open decision **OD-27**, default: not granted) |
| Branch access | The integration user gets every active location (needed by the ERP's location checks) |
| Rate limit | 300 requests/minute per token (`FIELD_API_RATE_PER_MINUTE`) → `429` with `Retry-After` |
| Tracing | `X-Request-Id` from field-api is echoed back and added to the ERP log context |

`php artisan field-api:setup` creates/refreshes the role and user, refuses to continue if the user is an admin, and prints the three `.env` lines plus the token **once**.

## 3. Conventions

- Base path: **`/api/field/v1`**. JSON only.
- Errors: `{"message": "...", "error": {"code": "PLAN_SETTLED", "details": {...}}}` with the HTTP status from §6.
- Unauthenticated: `401 {"message":"Unauthenticated.","error":{"code":"UNAUTHENTICATED"}}`.
- Lists: `{"data": [...], "meta": {"next_cursor": "aWQ6MTIz" | null, "server_time": "...", "page_size": 100}}`. The cursor is opaque; pass it back as `page[cursor]`.

## 4. Endpoints

### 4.1 `GET /health`
`200 {"status":"ok","time":"2026-11-18T11:05:00+06:00","version":"field-v1","timezone":"Asia/Dhaka"}`; `503` with `status: "degraded"` when the database is not reachable.

### 4.2 `GET /branches`
Locations with `type = branch`; `?type=all` adds warehouses. **field-api asks for `type=all`**: 35 receivable invoices (26 customers) sit on a warehouse location, and those customers would otherwise be skipped.
```json
{"data":[{"id":3,"code":"BSL","name":"Barishal Sadar","type":"branch","address":"Sadar Road, Barishal","phone":"01700000000","manager_name":"Branch Manager","is_active":true,"updated_at":"2026-10-01T10:00:00+06:00"}]}
```
No coordinates, district or Bangla name exist in the ERP.

### 4.3 `GET /employees`
```json
{"data":[{"id":7,"employee_code":"EMP-00007","name":"Field Officer One","phone":"01800000000","user_id":12,"branch_ids":[3],"is_active":true,"updated_at":"..."}]}
```
`is_active` = `employees.is_active` and `employment_status = active`. field-api stores `id` on its user as `erpEmployeeId`; that id is the collector of every field payment.

### 4.4 `GET /payment-methods[?branch_id=3]`
What each branch can take (the same list the office payment form shows: active method mapped to the branch wallet).
```json
{"data":[{"branch_id":3,"id":4,"code":"CASH-03","name":"Cash-03","type":"cash","mobile_provider":null}]}
```
`type` ∈ `cash | mobile_banking | bank | card_terminal`. Today only `cash` exists in production.

### 4.5 `GET /customers` — delta sync
| Query | Meaning |
|---|---|
| `scope` | `receivables` (default): customers that have at least one non-draft, not-deleted installment or credit invoice (≈ 1,441 today). `all`: every customer |
| `branch_id` | Customer's branch: `customers.branch_id`, or when empty the branch of the customer's latest invoice |
| `updated_since` | ISO timestamp. Customers whose own row, any invoice, schedule line or payment of theirs, or a payment removal / write-off / branch change in the audit log, changed at or after it |
| `page[size]` | 1–200, default 100 |
| `page[cursor]` | From `meta.next_cursor` |

Order is by customer id (stable while paging). **Watermark rule for the client:** store `meta.server_time` of the **first** page of a run and use it (minus a small overlap) as the next `updated_since`.

One customer:
```json
{
  "id": 100245, "customer_code": "CUS000245", "name": "Test Customer",
  "phone": "01711000001", "phone_numbers": ["01911000002"],
  "branch_id": 3, "branch_source": "customer",
  "address": "Village Road, Barishal", "detailed_address": null, "location_instructions": "Blue gate next to the mosque",
  "latitude": "22.70100000", "longitude": "90.35300000",
  "is_active": true, "outstanding_balance": "18000.00",
  "default_guarantor": null,
  "risk": {"grade": "C", "risk_level": "Medium", "classification": "isolated", "score": "62.50", "overdue_count": 1, "max_days_late": 12, "computed_at": "..."},
  "updated_at": "...", "changed_at": "...",
  "invoices": [ /* §4.5.1 */ ],
  "recent_payments": [ /* §4.5.2, newest first, at most 20 */ ],
  "removed_payments": [ /* §4.5.3 */ ]
}
```
- `branch_source`: `customer` | `last_invoice` | `null`.
- `latitude/longitude`: raw decimal strings or `null` (never `0`).
- `phone` / `phone_numbers` are returned as stored (may contain two numbers or text); field-api normalizes.
- `changed_at`: newest timestamp among the customer, its invoices, schedule lines and payments.

#### 4.5.1 Invoice (= one receivable = one "plan" in FOS)
Every non-draft installment or credit invoice of the customer (soft-deleted invoices are not returned; an invoice that disappears from the list is closed).
```json
{
  "id": 55021, "invoice_number": "INV-00921", "invoice_date": "2026-06-10", "branch_id": 3,
  "sale_type": "installment", "status": "active", "payment_status": "partial",
  "collectable": true,
  "grand_total": "36000.00", "discount_total": "0.00", "amount_paid": "18000.00", "amount_due": "18000.00",
  "written_off": "0.00", "credit_due_date": null,
  "items": [{"line_id": 9001, "product_id": 77, "name": "Refrigerator 252L", "model_number": "RF-252", "qty": 1, "line_total": "36000.00", "serials": ["SN-TEST-0001"]}],
  "guarantor": {"customer_id": null, "name": "Test Guarantor", "phones": ["01511000003"], "address": "Barishal"},
  "installment_plan": {
    "id": 801, "status": "active", "total_amount": "36000.00", "down_payment": "6000.00",
    "financed_amount": "30000.00", "remaining_amount": "18000.00",
    "frequency": "monthly", "custom_days": null, "installment_count": 6, "penalty_enabled": false,
    "schedules": [
      {"id": 12001, "installment_no": 1, "due_date": "2026-07-10", "due_amount": "5000.00", "paid_amount": "5000.00", "late_fee_amount": "0.00", "remaining_amount": "0.00", "status": "paid"}
    ]
  },
  "updated_at": "..."
}
```
- `collectable` = `status ∈ {posted, active}` and `amount_due > 0`. `returned` / `cancelled` are never collectable.
- `sale_type = credit` has no `installment_plan`; its single due date is `credit_due_date`.
- `guarantor`: invoice guarantor (if not the buyer), else the customer's default guarantor, else `null`. **NID is never included.**
- **Added 2026-11-18 (field-api 1.14.0, additive):** invoice `subtotal`, `tax_total`, `settlement_discount` (sum over live inbound payments), `refunded` (refunds of returns not rolled back); item `unit_price`, `discount_amount`, `service_charge`, `tax_amount`; plan `penalty_rate`; line `written_off` (from `installment_writeoff_allocations`) and `payments: [{"payment_id": 30411, "payment_number": "PAY-20261014-00012", "payment_date": "2026-10-14", "amount": "4837.67"}]` (from `installment_payment_allocations`, oldest first, removed payments left out). DiziCashier imports (`S-…`) were paid without allocation rows and send `payments: []`. field-api treats every one of these as optional.
- `schedules[].status` is the stored ERP value and is **stale** (see findings §2.4); clients compute status from `due_date`, `due_amount + late_fee_amount − paid_amount` and today's Dhaka date. A line with `due_amount = paid_amount = 0` was rolled forward into a later line.

#### 4.5.2 Payment
```json
{"id": 30411, "payment_number": "PAY-20261101-00012", "customer_id": 100245, "sales_invoice_id": 55021,
 "payment_date": "2026-11-01", "amount": "5000.00", "settlement_discount": "0.00",
 "payment_method": "cash", "payment_method_id": 4, "payment_method_name": "Cash-03", "payment_method_type": "cash",
 "collector_employee_id": 7, "collector_name": "Field Officer One", "reference_no": "Field Officer One",
 "is_advance": false, "source": "field_app", "idempotency_key": "0193a1b2-…", "created_at": "..."}
```
`source` = `field_app` when the payment was created through this API (found in `field_payment_requests`), else `office`. `is_advance` marks the ERP's down-payment advance.

#### 4.5.3 Removed payment
The ERP hard-deletes a payment when the office removes it; the API reads the audit log (`sales_invoice.payment_removed`).
```json
{"id": 30398, "payment_number": "PAY-20261020-00007", "payment_date": null, "sales_invoice_id": 55021, "amount": "5000.00", "removed_at": "...", "idempotency_key": null}
```
`payment_date` is known only for payments that came through this API (from `field_payment_requests`); for office payments it is `null` (the audit snapshot does not keep it) and field-api falls back to the date inside `payment_number`.

### 4.6 `GET /customers/{id}`
`{"data": <customer>}` (any customer, not only buyers). `404 CUSTOMER_NOT_FOUND`.

### 4.7 `GET /customers/{id}/payments`
Full inbound payment history, newest first. Query: `from`, `to` (dates), `page[size]` ≤ 200, `page[cursor]`.

### 4.8 `POST /payments` — record a field collection
Headers: `Authorization`, `Idempotency-Key` (required, ≤ 64 chars of `A–Z a–z 0–9 . _ : -`; field-api sends the collection's UUIDv7), optional `X-Request-Id`.

Body:
| Field | Type | Required | Notes |
|---|---|---|---|
| `sales_invoice_id` | int | yes | The invoice (FOS `erpPlanId`) |
| `customer_id` | int | yes | Must own the invoice |
| `amount` | decimal string | yes | > 0, two decimals max |
| `collected_at` | ISO timestamp | yes | The ERP `payment_date` is its Dhaka date |
| `method_type` | enum | yes | `cash`, `mobile_banking`, `bank`, `card_terminal` |
| `payment_method_id` | int | no | Pin one ERP method; otherwise the first method of that type at the invoice branch |
| `mobile_provider` | enum | no | `bkash`, `nagad`, `rocket`. With `mobile_banking`, only a method whose `mobile_provider` (or name) contains this word is used, so a bKash payment never lands in a Nagad wallet |
| `collector_employee_id` | int | no (1.35.0) | `employees.id` of the field officer (active). Since ERP field API change 2026-11-22 (ADR-049) it may be left out: the payment's referrer then stays empty |
| `collector_name` | string ≤ 100 | yes without `collector_employee_id` | Stored in `reference_no` like the office does; defaults to the employee name. field-api always sends it |
| `transaction_ref` | string ≤ 100 | no | bKash/Nagad TrxID |
| `field_receipt_no` | string ≤ 40 | yes | FOS receipt number |
| `field_collection_id` | string ≤ 64 | no | FOS collection id |
| `note` | string ≤ 300 | no | |

Checks, in order (first failure wins):
1. Same key seen before → same request hash: `200` replay of the first response; different hash: `422 IDEMPOTENCY_MISMATCH`. Another request with the key in flight: `409 CONCURRENT_REQUEST`.
2. Invoice exists, not deleted, belongs to `customer_id` → else `404 PLAN_NOT_FOUND`.
3. Installment or credit, `status ∈ {active, posted}` → else `422 PLAN_CLOSED`.
4. Customer active → else `422 CUSTOMER_INACTIVE`.
5. `amount_due > 0` → else `422 PLAN_SETTLED`; `amount ≤ amount_due` → else `422 AMOUNT_EXCEEDS_OUTSTANDING` (`details.outstanding`).
6. `collected_at` not in the future (`422 VALIDATION_FAILED`) and not older than `FIELD_API_MAX_BACKDATE_DAYS` when it is set (**OD-28 decided 2026-11-18: unset by default, any past date is accepted**) → `423 PERIOD_LOCKED` (`details.oldest_allowed`).
7. Collector is an active employee → else `422 COLLECTOR_NOT_LINKED`.
8. A method of `method_type` is available at the invoice branch → else `422 METHOD_NOT_AVAILABLE`.
9. Installment invoice already has an inbound payment (not the advance) on that date and the integration user lacks `installment.allow-same-day-duplicate` → `422 DUPLICATE_SAME_DAY`.
10. `PaymentService::recordAndAllocate(invoice, {amount, payment_method_id, reference: collector name, referrer_employee_id, date, installment_target: waterfall, notes: "[field_app] · Receipt <no> · Txn <ref> · <note>"})` inside one transaction together with the `field_payment_requests` row. ERP exceptions map to `AMOUNT_EXCEEDS_OUTSTANDING`, `DUPLICATE_SAME_DAY` or `ERP_REJECTED`.

What the ERP writes (all by its own service): `payments` (+ `payment_number`), `payment_allocations`, `installment_payment_allocations` (oldest line first), schedule `paid_amount`, plan and invoice totals, customer `outstanding_balance`, AR ledger, GL journal into the branch wallet, audit log. Plus one row in the new `field_payment_requests` table.

`201`:
```json
{"data": {"id": 30412, "payment_number": "PAY-20261118-00003", "sales_invoice_id": 55021, "customer_id": 100245,
  "amount": "5000.00", "payment_date": "2026-11-18", "payment_method_id": 4, "payment_method_name": "Cash-03",
  "posted_at": "2026-11-18T11:05:02+06:00", "invoice_amount_due_after": "13000.00", "customer_outstanding_after": "13000.00",
  "allocations": [{"installment_no": 4, "amount": "5000.00"}]},
 "idempotent_replay": false}
```
Failed requests are not stored, so the same key can be retried after the cause is fixed.

### 4.9 `GET /payments/by-idempotency-key/{key}`
`200 {"data": <same body as 201>, "idempotent_replay": true}` or `404 NOT_FOUND`. field-api calls this after a timeout before retrying, so a payment that was stored but whose response was lost is never posted twice.

## 5. New table `field_payment_requests`
| Column | Type | Notes |
|---|---|---|
| `id` | bigint PK | |
| `idempotency_key` | varchar(64) **unique** | |
| `request_hash` | char(64) | SHA-256 of invoice, customer, amount, method type/id, transaction ref, collected_at (UTC), collector |
| `payment_id` | bigint, index | `payments.id` (no FK, so an office removal never fails because of this table) |
| `sales_invoice_id`, `customer_id` | bigint, index | |
| `field_collection_id` | varchar(64) null | |
| `field_receipt_no` | varchar(40) | |
| `response` | json | The 201 body, replayed on retries |
| `created_at`, `updated_at` | timestamp | |

## 6. Error codes

| Code | HTTP | Meaning | field-api handling |
|---|---|---|---|
| `UNAUTHENTICATED` | 401 | Bad/missing token or inactive integration user | Pause posting, alert admins |
| `FORBIDDEN` | 403 | Integration user lacks `payment.create` | Same as 401 |
| `VALIDATION_FAILED` | 422 | Body/header invalid, future date | Conflict `ERP_VALIDATION` |
| `IDEMPOTENCY_MISMATCH` | 422 | Key reused with a different payment | Failed (bug), alert |
| `CONCURRENT_REQUEST` | 409 | Same key in flight | Retry in 5 s |
| `PLAN_NOT_FOUND` / `CUSTOMER_NOT_FOUND` | 404 | Invoice/customer missing or not the customer's | Conflict `PLAN_NOT_FOUND` |
| `PLAN_CLOSED` | 422 | Returned / cancelled / not an installment or credit invoice | Conflict `PLAN_CLOSED` |
| `CUSTOMER_INACTIVE` | 422 | | Conflict |
| `PLAN_SETTLED` | 422 | Nothing due | Conflict |
| `AMOUNT_EXCEEDS_OUTSTANDING` | 422 | More than the due | Conflict |
| `PERIOD_LOCKED` | 423 | Older than the back-date window | Conflict |
| `COLLECTOR_NOT_LINKED` | 422 | Collector not an active employee | Conflict; admin links the staff user |
| `METHOD_NOT_AVAILABLE` | 422 | No method of that type at the branch | Conflict; office adds the method |
| `DUPLICATE_SAME_DAY` | 422 | Installment invoice already paid that day | Conflict; office decides |
| `ERP_REJECTED` | 422 | Any other ERP rule | Conflict `ERP_VALIDATION` |
| — | 429 | Rate limit | Retry after `Retry-After` |
| — | 5xx | ERP error | Retry with backoff; check by key first |

## 7. Performance (measured on the sandbox copy)
- Full read of all 1,441 buyers in 15 pages of 100: about 1.3 s in total (eager-loaded, a fixed number of queries per page).
- Delta read with `updated_since`: one indexed union over five tables.
- Payment post: one transaction, same cost as an office payment.
- Suggested indexes (optional, later): `payments(updated_at)`, `sales_invoices(updated_at)`, `audit_logs(action, created_at)`. Not needed at today's volume.

## 8. Installing on production later (owner's go-ahead required)
1. Back up the database.
2. Copy the new files from `erp-api-prototype/files/` into the ERP (same paths) and add the one line to `bootstrap/providers.php`.
3. `php artisan migrate` (creates only `field_payment_requests`).
4. `php artisan field-api:setup` → put the printed `FIELD_API_ENABLED`, `FIELD_API_USER_ID`, `FIELD_API_TOKEN_SHA256` into `.env`; give the token to field-api as `ERP_API_TOKEN` (never in a repository).
5. `php artisan config:cache && php artisan route:cache`.
6. `curl -H "Authorization: Bearer …" https://<erp>/api/field/v1/health` → `ok`.
7. field-api: `ERP_MODE=live`, `ERP_BASE_URL=https://<erp>/api/field/v1`. Start with `erp.recordOnly = true` (reads only), check customers and balances in the admin panel, then switch posting on.
8. Before bKash/Nagad: add `mobile_banking` payment methods mapped to each branch wallet. Before go-live: link every field officer to an ERP employee.

**Rollback:** `FIELD_API_ENABLED=false` + `php artisan config:cache`. The new table can stay (it is only read by this module).

## 9. Open decisions for the owner
| ID | Question | Default until decided |
|---|---|---|
| OD-27 | May a field collection land on an installment invoice that already has a payment that day? | **No** (`DUPLICATE_SAME_DAY` conflict; the office decides) |
| OD-28 | How many days back may a field collection be dated? The office form allows 2 | **Decided 2026-11-18 by the owner: any past date** (no window unless `FIELD_API_MAX_BACKDATE_DAYS` is set); never a future date |
| OD-29 | Should staff pins be written back to the ERP customer lat/lng? | **No** in v1 (FOS keeps pins) |

## 10. Test evidence (sandbox)
- 6 feature tests in `tests/Feature/FieldApi/FieldApiTest.php` (auth/disabled, list shape and branch fallback and no NID, idempotent post and same-day rule and source/key, business errors, mobile-banking provider matching, office removal → `removed_payments` with key and date): **pass**.
- The ERP's own suite gives the same result with and without the module (426 vs 421 tests; the same 27 tests fail in both runs because of the sandbox's SQLite/PHP 8.3, none related to this module).
- Real-data run: field-api in live mode synced all 1,441 buyers from 15 locations in 12.5 s; its total outstanding equalled the ERP's collectable dues to the poisha; a field collection was posted through the outbox and came back with its key, a second one the same day became `DUPLICATE_SAME_DAY`, and an office removal showed up as reversed (details in the mapping document §7). The sandbox database was reloaded from the dump afterwards.

## 11. field-api side
- **Client:** `src/modules/erp-gateway/client/laravel-client.ts` (`ERP_MODE=live`, `ERP_BASE_URL=https://<erp>/api/field/v1`, `ERP_API_TOKEN`, optional `ERP_API_TOKEN_NEXT`). Mapping in `mappers/laravel-v1.ts` only; field-by-field table in [`erp-mapping.md`](erp-mapping.md).
- **Delta sync:** per location (`/branches?type=all`), `scope=receivables`, `updated_since` = the first page's `server_time` of the last good run minus 60 s. Since 1.44.0 (ADR-056) the cursor is saved after every page, so a stopped run continues on the next one, and a row field-api cannot read is skipped and logged with its id instead of stopping the branch. Since 1.44.0 (ADR-057, setting `erp.customerScope`, default `all`) field-api sends `scope=all&invoices=all` and `invoices=all` on `GET /customers/{id}` (howlader-ERP PR #5); on a 422 it falls back to `scope=all`, then to `scope=receivables`. Cash invoices map to `kind: cash`, no schedule, never due.
- **Mock:** `MockErpClient` applies the §4.8 rules in the same order (switches: `allowSameDay` for OD-27, `methodTypes` per branch, `maxBackdateDays`); `mock-erp/server.ts` replays the recorded fixtures over HTTP under `/api/field/v1`.
- **Fixtures:** `test/fixtures/erp/v1/*.json` are in the exact response shape of the prototype, with fake people. `area_code` and `name_bn` are not sent by the ERP; the fixtures keep `area_code` to exercise code-based areas.
- **Contract test:** `test/contract/mock-erp.contract.test.ts` (real HTTP client ↔ HTTP mock). When the ERP API is installed, re-record the fixtures from it and change the mappers only.
