# 05 — API Contract (field-api)

The machine-readable contract is **`docs/openapi.yaml`** (OpenAPI 3.1). This file explains conventions and gives worked examples. If the two disagree, `openapi.yaml` wins and this file must be fixed in the same PR.

## 1. Conventions

| Topic | Rule |
|---|---|
| Base URL | `https://api.<domain>/api/v1` |
| Versioning | URL major version. Additive changes (new optional fields, new endpoints, new enum values announced in CHANGELOG) allowed in v1. Removing/renaming fields or changing meaning → `/api/v2`. Clients must ignore unknown fields. |
| Auth | `Authorization: Bearer <accessToken>`. Admin refresh token in `HttpOnly; Secure; SameSite=Strict` cookie `fos_rt` (path `/api/v1/auth`); app refresh token in body. |
| Client headers | `X-Client: staff-app/1.4.2 (android 10; Redmi 9A)` or `admin-web/1.2.0`; `X-Device-Id` (app); `Accept-Language: bn|en`; `X-Request-Id` optional (echoed). |
| Version gate | App below `minAppVersion` → `426 UPGRADE_REQUIRED` on every call except `/meta/*`. |
| Content | JSON UTF-8; request bodies > 1 KB may be gzip (`Content-Encoding: gzip`), required for `/location/points`. |
| IDs | Server ids: 24-hex ObjectId strings. Client-created entity ids: `clientId` UUIDv7. |
| Money | `amountPoisha` integers. |
| Time | ISO 8601 UTC (`2026-11-15T05:12:44Z`); business dates `YYYY-MM-DD` (Dhaka). |
| Pagination | Cursor: `?limit=25&cursor=<opaque>` → `{ "items": [...], "nextCursor": "…" | null }`. Max limit 100. Total counts only via `?includeTotal=true` on admin lists (capped). |
| Sorting | `?sort=-daysOverdue,name` whitelisted per endpoint. |
| Filtering | Query params, comma lists for multi-value (`status=overdue,due_today`). |
| Idempotency | `Idempotency-Key` header (UUID) **required** on `POST /collections`, `POST /cash/deposits`, `POST /collections/{id}/resolve`; implicit via `clientId`/`mutationId` inside `/sync/push`. Replays return the original status and body plus header `Idempotent-Replayed: true`. |
| Concurrency | Mutable admin resources return `ETag: W/"<version>"`; updates require `If-Match` → `412 PRECONDITION_FAILED` on mismatch. |
| Errors | RFC 9457 `application/problem+json` with `code` (see §4). |
| Rate limits | `429` with `Retry-After`. Default 100/min/user, auth 10/min/IP, location 30 batches/min/user. |
| Feature flags | Disabled module → `403 FEATURE_DISABLED`. |
| Localization | Server-produced texts (notification bodies, error `title`) follow `Accept-Language`. |

## 2. Endpoint index

| Method & path | Permission | FR |
|---|---|---|
| `POST /auth/login` | public | FR-AUTH-001 |
| `POST /auth/refresh` | refresh token | FR-AUTH-002 |
| `POST /auth/logout` | auth | FR-AUTH-008 |
| `POST /auth/password/change` | auth | FR-AUTH-003 |
| `GET /auth/me` | auth | FR-RBAC-006 |
| `GET /auth/sessions` · `DELETE /auth/sessions/{id}` | auth (own) / `device.manage` | FR-AUTH-008 |
| `GET /meta/app-config` | public | FR-AUTH-009 |
| `GET /users` · `POST /users` · `GET/PATCH /users/{id}` | `user.view` / `user.manage` | FR-USER-001 |
| `POST /users/{id}/reset-password` · `POST /users/{id}/deactivate` · `POST /users/{id}/activate` | `user.manage` | FR-AUTH-004, FR-USER-002 |
| `GET /devices` · `POST /devices/{id}/unbind` · `POST /devices/{id}/approve` | `device.manage` | FR-AUTH-007 |
| `POST /devices/push-token` | auth | FR-NOT-001 |
| `GET /rbac/permissions` | `rbac.view` | FR-RBAC-002 |
| `GET /rbac/users/{userId}/effective` | `rbac.view` | FR-RBAC-004 |
| `PUT /rbac/overrides/branch/{branchId}` | `rbac.manage` | FR-RBAC-003 |
| `PUT /rbac/overrides/user/{userId}` | `rbac.manage` | FR-RBAC-003 |
| `GET /branches` | `branch.view` | FR-BR-001 |
| `GET /settings` · `PATCH /settings` | `settings.manage` (read subset: auth) | FR-SET-001 |
| `GET /feature-flags` · `PUT /feature-flags/{key}` | `flag.manage` | FR-FLAG-001 |
| `GET/POST /calendar/holidays` · `GET/POST/PATCH /shifts` | `settings.manage` | FR-SET-002/003 |
| `GET /customers` | `customer.view` | FR-CUS-001/002 |
| `GET /customers/map` | `customer.view` | FR-CUS-005 |
| `GET /customers/{id}` | `customer.view` | FR-CUS-003 |
| `GET /customers/{id}/timeline` | `customer.view` | FR-CUS-007 |
| `POST /customers/{id}/refresh` | `customer.view` | FR-ERP-003 |
| `POST /customers/{id}/location-proposals` | `customer.location.propose` | FR-CUS-008 |
| `GET /location-proposals` · `POST /location-proposals/{id}/decision` | `customer.location.approve` | FR-CUS-008 |
| `GET /attendance/events` (raw events of a staff member's day, with photo ids) | `attendance.view` | FR-ATT-001/004 |
| `GET /location-proposals/mine` (own proposals and their status; also sync entity `location_proposal`) | `customer.location.propose` | FR-CUS-008 |
| `GET /cowork/colleagues` · `POST /cowork/requests` · `GET /cowork/sessions/mine` · `POST /cowork/sessions/{id}/respond` · `POST /cowork/sessions/{id}/leave` | `cowork.use` | FR-CW-001/002 |
| `GET /cowork/sessions` · `GET /cowork/sessions/{id}` | `cowork.view` | FR-CW-004 |
| `PUT /customers/{id}/tag` | `tag.set` | FR-TAG-003 |
| `GET /customers/{id}/tag-history` | `tag.view` | FR-TAG-006 |
| `GET /tags/review-queue` · `POST /tags/review-queue/{eventId}/decision` | `tag.approve` | FR-TAG-005/007 |
| `POST /collections` | `collection.record` | FR-COL-001/004 |
| `GET /collections` · `GET /collections/{id}` | `collection.view` | FR-COL-010 |
| `POST /collections/{id}/void` | `collection.void` | FR-COL-009 |
| `POST /collections/{id}/resolve` | `collection.resolve` | FR-COL-007 |
| `GET /collections/conflicts` | `collection.resolve` | FR-COL-006 |
| `POST /receipts/blocks` | `collection.record` | FR-COL-002 |
| `GET /cash/me` · `GET /cash/positions` | `cash.view` | FR-CASH-001/005 |
| `POST /cash/deposits` · `GET /cash/deposits` | `cash.deposit.record` / `cash.view` | FR-CASH-003 |
| `POST /cash/deposits/{id}/verify` · `/reject` | `cash.deposit.verify` | FR-CASH-004 |
| `POST /cash/closings` | `cash.deposit.record` | FR-CASH-006 |
| `GET/POST /areas` · `PATCH /areas/{id}` | `assignment.view` / `assignment.manage` | FR-ASG-001 |
| `GET /assignments` · `POST /assignments` · `POST /assignments/bulk` · `DELETE /assignments/{id}` | `assignment.view` / `assignment.manage` | FR-ASG-002..004 |
| `POST /handovers` · `GET /handovers` · `GET /handovers/{id}` | `handover.create` / auth (party) | FR-HO-001/004 |
| `POST /handovers/{id}/accept` · `/reject` · `/cancel` | receiver / creator | FR-HO-002 |
| `POST /visits` · `PATCH /visits/{id}/checkout` · `GET /visits` | `visit.record` / `visit.view` | FR-VIS-001 |
| `POST /media/upload-url` · `POST /media/{id}/confirm` · `GET /media/{id}/url` | auth + entity permission | FR-MED-001 |
| `GET/POST /customers/{id}/notes` | `note.view` / `note.create` | FR-NOTE-001 |
| `GET /promises` · `POST /promises` · `POST /promises/{id}/cancel` | `promise.view` / `promise.create` | FR-PRM-001 |
| `POST /attendance/events` · `GET /attendance/me/today` | `attendance.record` | FR-ATT-001 |
| `GET /attendance/days` · `GET /attendance/summary` · `POST /attendance/corrections` | `attendance.view` / `attendance.manage` | FR-ATT-004/006 |
| `POST /leave-requests` · `GET /leave-requests` · `POST /leave-requests/{id}/decision` | `leave.request` / `attendance.manage` | FR-ATT-008 |
| `POST /location/points` · `POST /location/heartbeat` | auth (staff on duty) | FR-LOC-001..004/010 |
| `GET /location/latest` | `location.view` | FR-LOC-006 |
| `GET /location/history` · `GET /location/stops` | `location.history.view` | FR-LOC-007/008 |
| `GET /sync/pull` · `POST /sync/push` · `GET /sync/bootstrap` | auth (scope) | FR-SYNC-* |
| `GET /notifications` · `POST /notifications/{id}/read` · `POST /notifications/read-all` | auth | FR-NOT-003 |
| `POST /broadcasts` · `GET /broadcasts` · `POST /broadcasts/{id}/ack` | `notification.broadcast` / auth | FR-NOT-005 |
| `GET /inbox` · `POST /inbox/{id}/resolve` · `POST /inbox/{id}/snooze` | `inbox.view` | FR-INB-001 |
| `GET /dashboard/overview` | `report.view` | FR-DSH-001 |
| `GET /search` | auth (scoped) | FR-SRCH-001 |
| `GET /reports/staff-performance` · `GET /reports/branch-trends` · `GET /reports/reconciliation` | `report.view` | FR-REP-001/002, FR-COL-014 |
| `GET /reports/data-quality` · `GET /reports/data-quality/items` | `report.view` | FR-CUS-009 |
| `GET /reports/leaderboard` | `report.view`; field staff only when `reports.leaderboardVisibleToStaff` is on for their branch (own branch only) | FR-REP-005, OD-15 |
| `GET /reports/me/performance` | self (own figures only) | FR-REP-005 |
| `GET /targets` · `GET /targets/users/{id}/history` | `target.view` | FR-COL-015 |
| `PUT /targets/users/{id}` · `POST /targets/users/{id}/clear` · `PUT /targets/branches/{id}` | `target.manage` | FR-COL-015 |
| `GET /targets/me` | self | FR-COL-015 |
| `POST /reports/exports` · `GET /reports/exports/{id}` | `report.export` | FR-REP-004 |
| `GET /audit` | `audit.view` | FR-AUD-003 |
| `GET /system/health` · `GET /system/erp-status` · `GET /system/sync-health` | public (health) / `settings.manage` | FR-ERP-004, FR-SYNC-005 |

## 3. Worked examples

### 3.1 Login (app)
```http
POST /api/v1/auth/login
X-Client: staff-app/1.0.0 (android 10; Redmi 9A)
X-Device-Id: 0193a5e2-0000-7000-8000-00000000a001

{ "phone": "01712345678", "password": "••••••••", "client": "app" }
```
```json
200 OK
{ "accessToken": "eyJhbGciOiJFZERTQSJ9…", "accessTokenExpiresAt": "2026-11-15T03:15:00Z",
  "refreshToken": "rt_7Zq…", "refreshTokenExpiresAt": "2026-12-15T03:00:00Z",
  "user": { "id": "6734a1…", "name": { "bn": "রাকিব হাসান", "en": "Rakib Hasan" }, "role": "field_staff",
            "branchIds": ["6731aa…"], "employeeCode": "FS014", "mustChangePassword": false, "locale": "bn" },
  "permissions": ["branch.view","customer.view","customer.location.propose","tag.view","tag.set","collection.record","collection.view","cash.view","cash.deposit.record","assignment.view","visit.record","visit.view","note.create","note.view","promise.create","promise.view","attendance.record"],
  "flags": { "module.collections": true, "module.location": false },
  "serverTime": "2026-11-15T03:00:00Z" }
```
Errors: `401 INVALID_CREDENTIALS`, `423 ACCOUNT_LOCKED`, `403 DEVICE_NOT_APPROVED` (FR-AUTH-007), `426 UPGRADE_REQUIRED`.

### 3.2 Customer list (staff, due today, nearest first)
`GET /api/v1/customers?filter=due_today,overdue&assignedTo=me&near=22.7101,90.3705&sort=distance&limit=25`
```json
{ "items": [
  { "id": "6740…", "erpCustomerId": "C-100245", "code": "BRL01-100245",
    "name": { "bn": "মোঃ করিম উদ্দিন", "en": "Md Karim Uddin" }, "phone": "+8801811223344",
    "address": "Vill: Charkawa, Barishal Sadar",
    "location": { "lat": 22.7105, "lng": 90.3702, "status": "ok", "source": "erp" }, "distanceM": 48,
    "totalOutstandingPoisha": 850000, "nextDueDate": null, "daysOverdue": 36,
    "badges": ["overdue", "bad_suggested"], "tag": { "state": "none" },
    "openPromise": null, "lastVisitAt": "2026-11-10T06:01:00Z", "pendingFieldPoisha": 0,
    "erpFetchedAt": "2026-11-15T00:55:00Z" } ],
  "nextCursor": "eyJkIjo0OH0" }
```

### 3.3 Record a collection (online path)
```http
POST /api/v1/collections
Idempotency-Key: 0193a5e2-7c1f-7a3b-9e2d-4f6a8b1c2d3e

{ "clientId": "0193a5e2-7c1f-7a3b-9e2d-4f6a8b1c2d3e", "customerId": "6740…", "erpPlanId": "P-55021",
  "amountPoisha": 500000, "method": "bkash", "transactionRef": "AB12CD34EF",
  "receiptNo": "BRL01-FS014-261115-0007", "recordedAt": "2026-11-15T05:12:44Z", "deviceTime": "2026-11-15T05:12:40Z",
  "geo": { "lat": 22.7101, "lng": 90.3705, "accuracyM": 12, "mock": false },
  "visitClientId": "0193a5e1-…", "note": "রবিবারে বাকি দিবে" }
```
```json
201 Created
{ "id": "6750…", "clientId": "0193a5e2-…", "status": "received", "receiptNo": "BRL01-FS014-261115-0007",
  "flags": [], "cashOnHand": { "onHandPoisha": 3150000, "limitPoisha": 5000000, "state": "ok" } }
```
Replay with same key/payload → `200` same body, `Idempotent-Replayed: true`. Same key, different body → `409 IDEMPOTENCY_MISMATCH`.

### 3.4 Sync push (offline batch)
```json
POST /api/v1/sync/push
{ "deviceId": "0193a5e2-0000-7000-8000-00000000a001", "lastPullCursor": "s_88213",
  "mutations": [
    { "mutationId": "0193a5e1-aaaa-7000-8000-000000000001", "entity": "visit", "op": "create",
      "payload": { "clientId": "0193a5e1-…", "customerId": "6740…", "checkInAt": "2026-11-15T05:10:02Z", "outcome": "partial_paid",
                   "geo": { "lat": 22.7101, "lng": 90.3705, "accuracyM": 12, "mock": false }, "deviceTime": "2026-11-15T05:10:00Z" } },
    { "mutationId": "0193a5e2-7c1f-7a3b-9e2d-4f6a8b1c2d3e", "entity": "collection", "op": "create", "payload": { "…": "as 3.3" } },
    { "mutationId": "0193a5e3-…", "entity": "promise", "op": "create",
      "payload": { "clientId": "0193a5e3-…", "customerId": "6740…", "erpPlanId": "P-55021", "promisedDate": "2026-11-17", "promisedAmountPoisha": 350000 } } ] }
```
```json
200 OK
{ "serverTime": "2026-11-15T05:20:01Z",
  "results": [
    { "mutationId": "0193a5e1-aaaa-…", "result": "applied", "entityId": "6751…" },
    { "mutationId": "0193a5e2-7c1f-…", "result": "applied", "entityId": "6750…", "status": "received" },
    { "mutationId": "0193a5e3-…", "result": "applied", "entityId": "6752…", "supersededPromiseId": null } ] }
```
`result` values: `applied`, `replayed`, `conflict` (with `conflict.code`), `rejected` (with problem `code`; app shows message, keeps record in "Problems").

### 3.5 Sync pull
`GET /api/v1/sync/pull?cursor=s_88213&limit=500`
```json
{ "changes": [
    { "seq": 88214, "entity": "customer", "op": "upsert", "data": { "id": "6740…", "…": "same shape as list item + plans + recent notes" } },
    { "seq": 88215, "entity": "collection", "op": "upsert", "data": { "clientId": "0193a5e2-…", "status": "posted", "erpReceiptNo": "R-78010" } },
    { "seq": 88219, "entity": "customer", "op": "delete", "id": "6741…", "reason": "unassigned" } ],
  "nextCursor": "s_88219", "hasMore": false,
  "permissions": { "version": 12, "keys": ["…"] }, "flags": { "module.location": true },
  "settings": { "cash.limitMode": "warn", "location.sampling": { "fastSec": 15, "slowSec": 45, "stillSec": 180 } },
  "cash": { "onHandPoisha": 3150000, "limitPoisha": 5000000 },
  "target": { "businessDate": "2026-11-15", "amountPoisha": 2000000, "visits": 12, "source": "branch", "workingDay": true },
  "serverTime": "2026-11-15T05:20:03Z" }
```
`410 CURSOR_EXPIRED` → client calls `GET /sync/bootstrap` (full scope snapshot, paged).

### 3.6 Resolve a conflict (manager)
```json
POST /api/v1/collections/6750…/resolve
Idempotency-Key: 5d2c…
{ "action": "post_to_plan", "erpPlanId": "P-60110", "reason": "Customer's older plan already settled in office; apply to new fan plan" }
```
→ `200 { "id": "6750…", "status": "posting", "resolution": { "action": "post_to_plan", "by": "6734b2…", "at": "…" } }`

### 3.7 Tag a customer
```json
PUT /api/v1/customers/6740…/tag
If-Match: W/"7"
{ "state": "tagged", "severity": "bad", "reasonCode": "plan_ended_unpaid", "reason": "Plan ended 10 Oct, three visits refused" }
```
→ `200 { "tag": { "state": "tagged", "severity": "bad", "setBy": "…", "setAt": "…" }, "eventId": "…" }` (or `state: "pending"` if approval mode).

### 3.8 Location batch
```http
POST /api/v1/location/points
Content-Encoding: gzip
{ "deviceId": "…", "points": [ { "t": "2026-11-15T05:01:10Z", "lat": 22.71012, "lng": 90.37051, "acc": 9.5, "spd": 7.2, "hdg": 181, "alt": 4, "act": "in_vehicle", "bat": 0.64, "chg": false, "mock": false } ] }
```
→ `200 { "accepted": 118, "rejected": [ { "index": 7, "reason": "LOW_ACCURACY" } ], "nextSampling": { "fastSec": 15, "slowSec": 45, "stillSec": 180 } }`

### 3.9 Daily target and leaderboard
```http
PUT /api/v1/targets/users/6740aa…
{ "amountPoisha": 2500000, "visits": 15, "effectiveFrom": "2026-12-01", "reason": "Larger area from December" }
```
→ `200` the staff row as it applies on 2026-12-01 (`source: "personal"`). An `effectiveFrom` before today → `422 BUSINESS_RULE` with `details.rule = TARGET_IN_PAST` (past days keep their target). `POST /targets/users/{id}/clear` hands the person back to the branch default from a date.

`GET /api/v1/reports/leaderboard?period=month&date=2026-11&metric=target_achievement`
```json
{ "branchId": null, "period": "month", "date": "2026-11", "metric": "target_achievement", "minPresentDays": 1,
  "items": [ { "rank": 1, "userId": "6740aa…", "name": "Rakib Hasan", "employeeCode": "FS014", "value": 1.08, "collectedPoisha": 21600000,
               "visitCredit": 118, "promisesKept": 9, "amountAchievement": 1.08, "presentDays": 12, "eligible": true, "me": false } ],
  "me": null }
```
Achievement values are fractions with two decimals (1.08 = 108 %) against the target up to today.

## 4. Error codes

| HTTP | code | Meaning / client behaviour |
|---|---|---|
| 400 | `VALIDATION_FAILED` | `details.fields[]` per field; show inline. |
| 401 | `UNAUTHENTICATED` / `TOKEN_EXPIRED` | Refresh then retry once. |
| 401 | `INVALID_CREDENTIALS` | Show generic message. |
| 401 | `REFRESH_REUSED` | Session family revoked → force login. |
| 403 | `FORBIDDEN` | Missing permission (`details.permission`). |
| 403 | `FEATURE_DISABLED` | Hide feature; refresh flags. |
| 403 | `DEVICE_NOT_APPROVED` | Show "waiting for manager approval". |
| 403 | `PASSWORD_CHANGE_REQUIRED` | Route to change password. |
| 404 | `NOT_FOUND` | Also used for out-of-scope resources. |
| 409 | `IDEMPOTENCY_MISMATCH` | Bug or tampering; log, do not retry. |
| 409 | `INVALID_STATE` | e.g. accept an expired handover, break_end without break_start. |
| 409 | `DUPLICATE_RECEIPT_NO` | Device sequence problem → request new block. |
| 410 | `CURSOR_EXPIRED` | Bootstrap. |
| 412 | `PRECONDITION_FAILED` | Reload and retry edit. |
| 413 | `PAYLOAD_TOO_LARGE` | Split batch. |
| 422 | `OFF_DUTY` | Location outside duty; drop points. |
| 422 | `BUSINESS_RULE` | `details.rule` (e.g. `PROMISE_DATE_RANGE`, `REASON_REQUIRED`, `LAST_SUPER_ADMIN`, `COWORK_INVALID_INVITEE`, `COWORK_TOO_MANY`, `TARGET_IN_PAST`). |
| 423 | `ACCOUNT_LOCKED` | `details.until`. |
| 426 | `UPGRADE_REQUIRED` | `details.minVersion`, `details.storeUrl`. |
| 429 | `RATE_LIMITED` | Honour `Retry-After`. |
| 502/503 | `ERP_UNAVAILABLE` | Only on live ERP reads (`/refresh`); app keeps cached data. |
| 500 | `INTERNAL` | `requestId` shown in "copy error details". |

Conflict codes (inside collection `conflict.code`, not HTTP errors): `PLAN_SETTLED`, `AMOUNT_EXCEEDS_OUTSTANDING`, `PLAN_NOT_FOUND`, `CUSTOMER_INACTIVE`, `PERIOD_LOCKED`, `ERP_VALIDATION`, `NOT_IN_SCOPE_AT_RECORD_TIME`.

## 5. Type generation for consumers
- `admin-web`: `pnpm gen:api` runs `openapi-typescript ../field-api/docs/openapi.yaml -o src/shared/api/schema.d.ts` (or from a pinned release URL/commit) and uses `openapi-fetch`.
- `staff-app`: `make gen-api` runs `openapi-generator-cli generate -g dart-dio` into `packages/field_api_client/` (generated, not edited) **or** hand-written freezed models validated by contract tests against `openapi.yaml` examples (ADR-004).
- The contract version is `info.version` in openapi.yaml; consumers record the version they generated from in their CHANGELOG.
