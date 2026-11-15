# ERP Integration Spec — Laravel ↔ field-api

> Audience: the Laravel maintainer and the field-api implementer.
> Laravel is **not restructured** by this work. The only change requested on the Laravel side is a set of **new, additive, versioned endpoints** under one prefix, implemented later by the maintainer, following the maintainer's own project guidelines.
> Everything below about Laravel's internal schema is an **ASSUMPTION** until verified (see §9). No Laravel table or column name is stated as a fact.

## 1. Principles

1. **Laravel is the source of truth** for customers, plans, schedules, payments and balances.
2. **Additive only:** new routes, new controller(s), new API resources, one new table for idempotency keys if Laravel has none (the maintainer decides how). No change to existing routes, tables' meaning, or business logic.
3. **One integration user** with a Sanctum personal access token, restricted by ability scopes (§3).
4. **Read endpoints** are paginated and support `updated_since` so field-api can sync deltas.
5. **Write endpoint** (payments) is **idempotent** by `Idempotency-Key` and lets Laravel apply its *own* allocation and validation rules. field-api never tells Laravel how to allocate money across schedule lines.
6. **Field-api adapts to Laravel**, not the reverse: all Laravel field names are isolated in `src/modules/erp-gateway/mappers/`. If the maintainer prefers different names or shapes, only the mappers and fixtures change.

## 2. Base

| Item | Value (proposal) |
|---|---|
| Prefix | `/api/integrations/field/v1` (maintainer may rename; keep a version segment) |
| Format | JSON, UTF-8, `snake_case` keys (Laravel convention), dates `YYYY-MM-DD`, timestamps ISO-8601 with offset |
| Money | Decimal strings with 2 places (`"8500.00"`) **or** integer poisha — **ASSUMPTION E-08**; field-api mapper converts to poisha either way. Never floats in JSON numbers. |
| Timezone | Laravel `APP_TIMEZONE` — ASSUMPTION E-09 (expected `Asia/Dhaka`) |
| Transport | HTTPS only; field-api egress IP(s) may be allow-listed |
| Rate | field-api stays ≤ 5 req/s sustained, ≤ 20 req/s burst |

## 3. Authentication

- Laravel Sanctum **personal access token** issued to a dedicated user, e.g. `field-integration@…`, created by the maintainer.
- Header: `Authorization: Bearer <token>`; `Accept: application/json`; `X-Request-Id: <uuid>` (Laravel should log it).
- Token abilities (Sanctum `abilities`), proposal:
  - `field:read` — all GET endpoints below
  - `field:payments:write` — `POST /payments`
  - `field:coordinates:write` — optional §5.3
- Token rotation: every 90 days, overlap of 7 days (two tokens valid). field-api reads `ERP_API_TOKEN` and `ERP_API_TOKEN_NEXT`.
- The integration user must **not** be able to log in to the Laravel UI.

## 4. Read endpoints

### 4.1 `GET /branches`
```json
{ "data": [ { "id": 3, "code": "BRL01", "name": "Barishal Sadar", "name_bn": "বরিশাল সদর", "district": "Barishal",
              "address": "Sadar Road, Barishal", "latitude": "22.701002", "longitude": "90.353451", "is_active": true,
              "updated_at": "2026-10-01T10:00:00+06:00" } ] }
```

### 4.2 `GET /customers`
Query: `branch_id` (optional), `updated_since` (ISO timestamp; returns customers whose customer row **or any plan, schedule line, or payment** changed since), `page[size]` (≤ 200, default 100), `page[cursor]` (cursor pagination preferred; offset `page` acceptable — ASSUMPTION E-12), `include=plans,schedule,recent_payments` (default all), `status=active|all`.

```json
{ "data": [
  { "id": 100245, "code": "BRL01-100245", "branch_id": 3,
    "name": "Md Karim Uddin", "name_bn": "মোঃ করিম উদ্দিন",
    "phones": ["01811223344"], "guarantor": { "name": "Abdul Malek", "phone": "01911000000" },
    "address": "Vill: Charkawa, Barishal Sadar", "area_code": "BSL-CHK",
    "latitude": "22.710500", "longitude": "90.370200",
    "status": "active", "updated_at": "2026-11-14T16:22:00+06:00",
    "plans": [
      { "id": 55021, "product_name": "Walton Fridge WFC-3D8", "sale_date": "2026-05-10",
        "principal": "65000.00", "down_payment": "10000.00", "total_payable": "68000.00",
        "installment_count": 6, "start_date": "2026-05-10", "end_date": "2026-10-10",
        "paid_total": "59500.00", "outstanding": "8500.00", "status": "active",
        "schedule": [ { "seq": 1, "due_date": "2026-06-10", "amount": "9667.00", "paid": "9667.00" } ] } ],
    "recent_payments": [ { "id": 9921, "plan_id": 55021, "date": "2026-09-12", "amount": "9667.00", "method": "cash",
                           "source": "office", "receipt_no": "R-77812", "idempotency_key": null, "is_reversed": false } ] } ],
  "meta": { "next_cursor": "eyJpZCI6MTAwMjQ1fQ", "server_time": "2026-11-15T07:00:00+06:00" } }
```
Notes:
- `recent_payments`: last 20 per customer (field-api shows full history through 4.4).
- `end_date` = plan's final due date. If no such field exists, Laravel returns `null` and field-api uses max(`schedule[].due_date`) — **ASSUMPTION E-05**.
- `outstanding` must be computed by **Laravel's own** balance logic (the same number the office sees) — **ASSUMPTION E-06**.
- `schedule[].paid` per line is optional — if Laravel does not track per-line paid amounts, return `null` and field-api estimates oldest-first for display only — **ASSUMPTION E-07**.

### 4.3 `GET /customers/{id}`
Same shape as one item of 4.2 with all includes. `404` if not found. Used for on-demand refresh.

### 4.4 `GET /customers/{id}/payments`
Query: `page[size]`, `page[cursor]`, `from`, `to`. Full payment history including reversed payments (`is_reversed`, `reversed_at`, `reversal_reason`).

### 4.5 `GET /payments/by-idempotency-key/{key}`
Returns the payment created with that key (same shape as §5.1 response) or `404`. Used by field-api after a timeout before retrying.

### 4.6 `GET /changes` (optional, preferred if cheap to build)
A single change feed: `?since_id=` returns `{ "data": [ { "id": 88123, "entity": "customer|plan|payment", "entity_id": 100245, "customer_id": 100245, "changed_at": "…" } ], "meta": { "last_id": 88140 } }`. If Laravel cannot provide it, `updated_since` on 4.2 is sufficient — **ASSUMPTION E-13**.

### 4.7 `GET /employees` (optional)
`{ "data": [ { "id": "E-2231", "name": "Rakib Hasan", "phone": "01712345678", "branch_id": 3, "is_active": true } ] }` — lets field-api link users to ERP employees (`erpEmployeeId`) and pass `collected_by_employee_id` on payments. **ASSUMPTION E-16**.

### 4.8 `GET /health`
`{ "status": "ok", "time": "2026-11-15T07:00:00+06:00", "version": "…" }` — no DB-heavy work.

## 5. Write endpoints

### 5.1 `POST /payments`
Headers: `Idempotency-Key: <uuid>` (**required**, the staff-app's UUIDv7, unchanged end-to-end).

Request:
```json
{ "customer_id": 100245,
  "plan_id": 55021,
  "amount": "5000.00",
  "method": "bkash",
  "transaction_ref": "AB12CD34EF",
  "collected_at": "2026-11-15T11:12:44+06:00",
  "collected_by_employee_id": "E-2231",
  "field_receipt_no": "BRL01-FS014-261115-0007",
  "physical_receipt_no": null,
  "branch_id": 3,
  "note": "Field collection via Howlader Field App",
  "source": "field_app",
  "field_collection_id": "6750a1b2c3d4e5f6a7b8c9d0",
  "geo": { "latitude": "22.710100", "longitude": "90.370500", "accuracy_m": 12 } }
```
Laravel behaviour (requested):
1. Look up `Idempotency-Key`. If found with an **identical** normalized payload → return the original response with `200` and `"idempotent_replay": true`. If found with a **different** payload → `422` `IDEMPOTENCY_MISMATCH`.
2. Validate; apply Laravel's normal payment logic (allocation, receipts, ledgers) exactly as an office payment, marked with `source = field_app`.
3. Store the key with a **unique constraint** (retained ≥ 400 days).
4. Return `201`:
```json
{ "data": { "id": 10233, "receipt_no": "R-78010", "customer_id": 100245, "plan_id": 55021, "amount": "5000.00",
            "posted_at": "2026-11-15T11:20:05+06:00",
            "plan_outstanding_after": "3500.00", "customer_outstanding_after": "3500.00",
            "allocations": [ { "seq": 6, "amount": "5000.00" } ] },
  "idempotent_replay": false }
```

### 5.2 Business errors (how field-api maps them to conflicts)

| HTTP | `error.code` (proposal) | Meaning | field-api action |
|---|---|---|---|
| 422 | `PLAN_SETTLED` | Plan already fully paid (e.g. paid at office) | conflict `PLAN_SETTLED` |
| 422 | `AMOUNT_EXCEEDS_OUTSTANDING` | Amount > outstanding and Laravel does not accept advances | conflict |
| 404 | `PLAN_NOT_FOUND` / `CUSTOMER_NOT_FOUND` | | conflict `PLAN_NOT_FOUND` |
| 422 | `CUSTOMER_INACTIVE` | Customer closed/blocked | conflict |
| 423 | `PERIOD_LOCKED` | Accounting period closed for `collected_at` date | conflict `PERIOD_LOCKED` |
| 422 | `VALIDATION_FAILED` | `errors: { field: [msg] }` (Laravel default shape OK) | conflict `ERP_VALIDATION` |
| 422 | `IDEMPOTENCY_MISMATCH` | | critical alert, no retry |
| 401/403 | — | token/ability problem | alert ops, pause outbox |
| 409 | `CONCURRENT_REQUEST` | same key in flight | retry after 5 s |
| 429 | — | `Retry-After` honoured | retry |
| 5xx / timeout | — | | lookup by key (4.5), then retry with backoff |

Error body shape (Laravel-friendly):
```json
{ "message": "Plan already settled", "error": { "code": "PLAN_SETTLED", "details": { "plan_id": 55021, "outstanding": "0.00" } } }
```

### 5.3 `PATCH /customers/{id}/coordinates` (optional, phase 4)
`{ "latitude": "22.710300", "longitude": "90.370100", "source": "field_app", "approved_by": "manager name", "approved_at": "…" }` → `200`. Only if the business wants approved pin corrections written back. Otherwise FOS keeps them as an overlay. **ASSUMPTION E-14**.

### 5.4 Tag write-back (optional)
If Laravel has a "defaulter"/"blacklist" flag that office staff use, an endpoint `PUT /customers/{id}/field-tag` may be added later. **ASSUMPTION E-15**. Default: FOS-only.

## 6. Pagination
- Cursor preferred: `meta.next_cursor` (null at end). Stable order by `(updated_at, id)`.
- If only offset pagination exists, field-api uses `page`/`per_page` with `updated_since` and an overlap window of 60 s, de-duplicating by `id`.

## 7. Idempotency rule (single statement)
> Every payment created through this integration carries a client-generated UUID **Idempotency-Key**, generated once on the staff device when the collection is saved, never regenerated. field-api and Laravel each store it under a unique constraint. Same key + same payload → the original result is returned (no second payment). Same key + different payload → rejected. Before retrying after a timeout, field-api queries Laravel by key.

Normalized payload for comparison: `customer_id, plan_id, amount, method, transaction_ref, collected_at` (other fields informational).

## 8. Reversals
- FOS **never** reverses or edits a posted payment.
- Reversals happen in Laravel by authorised office staff using Laravel's existing process — **ASSUMPTION E-17** that such a process exists.
- Laravel exposes reversal via `recent_payments[].is_reversed` and the payments endpoint; field-api's sync marks the field collection `erp.reversed = true`, raises an inbox item, and notifies the collector and manager.

## 9. Assumptions register (verify against Laravel repo)

| ID | Assumption | Why it matters | Status |
|---|---|---|---|
| E-01 | Laravel has a customer entity with a stable numeric/string id and a branch id. | Keys for cache and scope | verify against Laravel repo |
| E-02 | Customer coordinates are stored as two columns (latitude, longitude) on the customer or address record; column names unknown. | Map pins | verify against Laravel repo |
| E-03 | Coordinates may be null, `0`, `0.000000`, swapped, or the branch's own location; there is no accuracy/source field. | Validation rules FR-CUS-004 | verify against Laravel repo |
| E-04 | A customer can have more than one active installment plan. | planId required on collection | verify against Laravel repo |
| E-05 | Plans have an explicit end/final due date; if not, the last schedule line's due date is equivalent. | Bad-customer rule FR-TAG-001 | verify against Laravel repo |
| E-06 | Laravel computes outstanding balance per plan with its own logic (incl. down payment, discounts, penalties?), and the API returns that same number. | Never recompute money in FOS | verify against Laravel repo |
| E-07 | Per-schedule-line paid amounts may not be stored. | "Due today/overdue" accuracy | verify against Laravel repo |
| E-08 | Money stored as DECIMAL(…,2) in BDT. | Conversion to poisha | verify against Laravel repo |
| E-09 | App timezone is Asia/Dhaka; timestamps without offset are Dhaka local. | Date rules | verify against Laravel repo |
| E-10 | Branch ids are stable integers and match what office users know as branches. | Branch mirror | verify against Laravel repo |
| E-11 | Customers have some area/zone/route code usable for areas. | Area assignment FR-ASG-001 | verify against Laravel repo |
| E-12 | List endpoints can support cursor pagination; else offset. | Sync design | verify against Laravel repo |
| E-13 | `updated_at` on customer/plan/payment rows is reliably updated on every change (including payments touching balances). | Delta sync correctness | verify against Laravel repo |
| E-14 | Writing coordinates back is acceptable to the business. | Optional endpoint | verify with business |
| E-15 | A defaulter/blacklist flag may exist in Laravel. | Tag write-back | verify against Laravel repo |
| E-16 | Employees exist in Laravel with ids usable as `collected_by_employee_id`. | Payment attribution | verify against Laravel repo |
| E-17 | Laravel has a payment reversal/cancellation process with audit. | Reversal flow §8 | verify against Laravel repo |
| E-18 | Payment methods in Laravel include or can map to cash / bKash / Nagad / Rocket / bank. | Method mapping | verify against Laravel repo |
| E-19 | Laravel has its own receipt/voucher numbering for payments. | `erpReceiptNo` | verify against Laravel repo |
| E-20 | Laravel accepts advance payments (amount > current due) and/or overpayment. | Conflict rules | verify against Laravel repo |
| E-21 | Accounting periods can be locked. | `PERIOD_LOCKED` | verify against Laravel repo |
| E-22 | Laravel has an existing roles/permissions model (e.g. a package or custom tables). | Reconcile RBAC naming; no dependency | verify against Laravel repo |
| E-23 | Laravel's API stack already uses Sanctum, or it can be added without affecting existing auth. | Auth | verify against Laravel repo |
| E-24 | Customer phone numbers are stored in local `01XXXXXXXXX` format. | Normalization | verify against Laravel repo |
| E-25 | Customer Bangla name is stored (or only English). | Bangla UI | verify against Laravel repo |
| E-26 | Laravel production can handle ~1 request/s of integration reads during business hours. | Sync frequency | verify with maintainer |

## 10. Questions for the Laravel maintainer (checklist)

**Coordinates**
- [ ] Which table/columns hold customer latitude/longitude? Data type and precision?
- [ ] What is stored when unknown: `NULL`, `0`, empty string? Any rows with the branch location copied in?
- [ ] Is there an address-level vs customer-level location? Which should we use?
- [ ] Is writing corrected coordinates back acceptable (§5.3)?

**Plans and schedule**
- [ ] Which field is the plan's final due date / end date? If none, is "last schedule due date" correct?
- [ ] Are schedule lines stored, or generated on the fly? Are per-line paid amounts stored?
- [ ] Can one customer hold several active plans? How are plans closed/cancelled/returned?
- [ ] Are penalties/late fees part of outstanding?

**Balance**
- [ ] Exactly how is outstanding balance computed (formula/service class)? Can the API return the same value the office sees?
- [ ] Are discounts/waivers stored as payments or separately?

**Payments**
- [ ] How are payments allocated across schedule lines (oldest first? specified line?)
- [ ] What receipt/voucher number does Laravel generate? Is it per branch?
- [ ] Are advance payments and overpayments allowed? What happens to excess?
- [ ] Payment methods enum values? Is a mobile transaction reference stored?
- [ ] Reversal rules: who can reverse, is it a new negative entry or a flag, is it audited, time limits?
- [ ] Are accounting periods/day-closings locked? From what time?
- [ ] Can we add an idempotency-key table/column (unique) without touching existing logic?

**Branches, employees, permissions**
- [ ] Branch ids and codes list; are they stable?
- [ ] Do field staff exist as employees/users in Laravel? Id field?
- [ ] What permission/role model exists (package, custom)? Any naming conventions we should mirror?

**API conventions**
- [ ] Is Sanctum installed? Token abilities used? Any API versioning convention already?
- [ ] Response envelope convention (`data`/`meta`), error format, pagination style?
- [ ] Is `updated_at` touched on all relevant changes (payment insert → plan/customer `updated_at`)?
- [ ] Production capacity, maintenance windows, staging environment availability?
- [ ] Laravel project guidelines document (coding standards, folder conventions, testing) — please share; this spec will be reconciled with it.

## 11. Reconciling with the Laravel guidelines (later)
When the maintainer shares guidelines:
1. Rename prefix/paths/keys to their conventions — update `mappers/` and `test/fixtures/erp/` only.
2. Re-record fixtures from Laravel staging (`pnpm erp:record --env=staging`) and re-run contract tests.
3. Update §9 statuses to `verified` or `changed (see note)`, and add an ADR if behaviour differs.
4. Bump `erp-integration-spec` version in the header and CHANGELOG.

## 12. Contract testing
- Fixtures: `test/fixtures/erp/v1/<endpoint>/<case>.json` with request + response + headers, recorded from Laravel staging (sanitised: names/phones replaced) or hand-written from this spec until staging exists.
- `mock-erp/` serves fixtures for local dev and CI.
- Contract tests assert: mappers handle every fixture; required fields present; money/date parsing; error code mapping table §5.2; idempotent replay path; timeout → lookup-by-key path.
- A **provider verification** script (`scripts/erp-verify.ts`) can be handed to the maintainer to run against their staging to confirm the endpoints match this spec.

## 13. Rollout with Laravel
1. Read endpoints first (4.1–4.3) → phase 1 can run with posting disabled (`erp.mode = record_only`).
2. `POST /payments` + lookup by key → enable posting for one branch (flag) → reconcile daily for 2 weeks → enable all branches.
3. Optional endpoints (changes feed, employees, coordinates) when available.
