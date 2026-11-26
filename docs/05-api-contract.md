# 05 — API Contract (field-api)

The machine-readable contract is **`docs/openapi.yaml`** (OpenAPI 3.1). This file explains conventions and gives worked examples. If the two disagree, `openapi.yaml` wins and this file must be fixed in the same PR.

## 1. Conventions

| Topic | Rule |
|---|---|
| Base URL | `https://api.<domain>/api/v1` |
| Versioning | URL major version. Additive changes (new optional fields, new endpoints, new enum values announced in CHANGELOG) allowed in v1. Removing/renaming fields or changing meaning → `/api/v2`. Clients must ignore unknown fields. |
| Auth | `Authorization: Bearer <accessToken>`; the staff app's native location service uses `Authorization: Tracking <token>` on `POST /location/points` only (1.49.0, §3.9n). Admin refresh token in `HttpOnly; Secure; SameSite=Strict` cookie `fos_rt` (path `/api/v1/auth`); app refresh token in body. |
| Client headers | `X-Client: staff-app/1.4.2 (android 10; Redmi 9A)` or `admin-web/1.2.0`; `X-Device-Id` (app); `Accept-Language: bn|en`; `X-Request-Id` optional (echoed). |
| Version gate | App below `minAppVersion` → `426 UPGRADE_REQUIRED` on every call except `/meta/*`. |
| Content | JSON UTF-8; request bodies > 1 KB may be gzip (`Content-Encoding: gzip`), required for `/location/points`. |
| IDs | Server ids: 24-hex ObjectId strings. Client-created entity ids: `clientId` UUIDv7. |
| Money | `amountPoisha` integers. |
| Time | ISO 8601 UTC (`2026-11-15T05:12:44Z`); business dates `YYYY-MM-DD` (Dhaka). |
| Pagination | Cursor: `?limit=25&cursor=<opaque>` → `{ "items": [...], "nextCursor": "…" | null }`. Max limit 100. Total counts only via `?includeTotal=true` on admin lists (capped). Exception since 1.46.0: `GET /customers` takes `limit` ≤ 1000 and `offset` (§3.9i), and its `total` is exact. |
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
| `GET/POST /calendar/holidays` · `DELETE /calendar/holidays/{id}` (1.12.0) · `GET/POST/PATCH /shifts` | `settings.manage` (both GETs: any signed-in user) | FR-SET-002/003 |
| `GET /attendance/me/shift` (own shift or the branch default, 1.12.0) | `attendance.record` | FR-SET-003 |
| `GET /customers` | `customer.view` | FR-CUS-001/002 |
| `GET /customers/map` | `customer.view` | FR-CUS-005 |
| `GET /customers/{id}` | `customer.view` | FR-CUS-003 |
| `GET /customers/{id}/timeline` | `customer.view` | FR-CUS-007 |
| `POST /customers/{id}/refresh` | `customer.view` | FR-ERP-003 |
| `POST /customers/{id}/location-proposals` | `customer.location.propose` (applies at once if the caller also holds `customer.location.approve` for the branch, 1.39.0) | FR-CUS-008, FR-CUS-020 |
| `GET /location-proposals` · `POST /location-proposals/{id}/decision` | `customer.location.approve` | FR-CUS-008 |
| `GET /attendance/events` (raw events of a staff member's day, with photo ids) | `attendance.view` | FR-ATT-001/004 |
| `GET /location-proposals/mine` (own proposals and their status; also sync entity `location_proposal`) | `customer.location.propose` | FR-CUS-008 |
| `POST /customers/{id}/location` (manager sets the pin on the map, 1.11.0) | `customer.location.approve` | FR-CUS-011 |
| `DELETE /customers/{id}/location` (manager deletes the pin, 1.17.0; answer `{removed, location}`) | `customer.location.approve` | FR-CUS-014 |
| `POST /system/erp-sync` ("Sync from ERP", 1.17.0; answer `{customers, branches, partial, durationMs, finishedAt}`, since 1.44.0 also `skipped` and `failedBranches`; which customers are pulled: setting `erp.customerScope` = `all` (default) \| `receivables`; call again while `partial`; 429 `SYNC_RUNNING`, 503 `ERP_UNAVAILABLE`) | `erp.sync` | FR-ERP-007 |
| `GET /cowork/colleagues` · `POST /cowork/requests` · `GET /cowork/sessions/mine` · `POST /cowork/sessions/{id}/respond` · `POST /cowork/sessions/{id}/leave` | `cowork.use` | FR-CW-001/002 |
| `GET /cowork/sessions` · `GET /cowork/sessions/{id}` | `cowork.view` | FR-CW-004 |
| `POST /cowork/sessions/{id}/end` `{ reason }` (1.34.0) | `cowork.manage` | FR-CW-006 |
| `GET /tasks/mine` · `POST /tasks/{id}/resolve-request` (also sync mutation `task_resolve_request`, sync entity `task`) | `task.work` | FR-TASK-002 |
| `GET /tasks` · `GET /tasks/{id}` | `task.view` | FR-TASK-004 |
| `POST /tasks` · `PATCH /tasks/{id}` · `POST /tasks/{id}/verify` · `POST /tasks/{id}/reject` · `POST /tasks/{id}/cancel` | `task.manage` | FR-TASK-001/003 |
| `PUT /customers/{id}/tag` | `tag.set` | FR-TAG-003 |
| `GET /customers/{id}/tag-history` | `tag.view` | FR-TAG-006 |
| `GET /tags/review-queue` · `POST /tags/review-queue/{eventId}/decision` | `tag.approve` | FR-TAG-005/007 |
| `POST /collections` | `collection.record` | FR-COL-001/004 |
| `GET /collections` · `GET /collections/{id}` | `collection.view` | FR-COL-010 |
| `POST /collections/{id}/void` | `collection.void` | FR-COL-009 |
| `POST /collections/{id}/withdraw` | `collection.withdraw` | FR-COL-016 |
| `PATCH /collections/{id}` | `collection.edit` | FR-COL-016 |
| `POST /collections/{id}/resolve` | `collection.resolve` | FR-COL-007 |
| `GET /collections/conflicts` | `collection.resolve` | FR-COL-006 |
| `POST /receipts/blocks` | `collection.record` | FR-COL-002 |
| `GET /cash/me` · `GET /cash/positions` | `cash.view` | FR-CASH-001/005 |
| `POST /cash/deposits` · `GET /cash/deposits` | `cash.deposit.record` / `cash.view` | FR-CASH-003 |
| `POST /cash/deposits/{id}/verify` · `/reject` | `cash.deposit.verify` | FR-CASH-004 |
| `POST /cash/deposits/{id}/delete` | `cash.deposit.delete` | FR-CASH-009 |
| `POST /cash/closings` | `cash.deposit.record` | FR-CASH-006 |
| `GET/POST /areas` · `PATCH /areas/{id}` | `assignment.view` / `assignment.manage` | FR-ASG-001 |
| `GET /assignments` · `POST /assignments` · `POST /assignments/bulk` · `DELETE /assignments/{id}` | `assignment.view` / `assignment.manage` | FR-ASG-002..004 |
| `POST /handovers` · `GET /handovers` · `GET /handovers/{id}` | `handover.create` / auth (party) | FR-HO-001/004 |
| `POST /handovers/{id}/accept` · `/reject` · `/cancel` | receiver / creator | FR-HO-002 |
| `POST /visits` · `PATCH /visits/{id}/checkout` · `GET /visits` | `visit.record` / `visit.view` | FR-VIS-001 |
| `POST /media/upload-url` · `POST /media/{id}/confirm` · `GET /media/{id}/url` | auth + entity permission | FR-MED-001/002 |
| `GET /media/purge/preview` · `POST /media/purge` (photos of previous months, 1.37.0) | `media.delete` | FR-MED-003 |
| `POST /attendance/photos/delete` (one staff member's attendance photos of a day, 1.37.0) | `media.delete` | FR-MED-004 |
| `GET/POST /places` · `GET/PATCH/DELETE /places/{id}` · `POST /places/{id}/move-request` · `GET /places/move-requests` · `POST /places/{id}/move-request/decision` (map places, 1.38.0) | `place.view` / `place.create` (own places) / `place.manage` | FR-PLC-001..006 |
| `GET/POST /customers/{id}/notes` | `note.view` / `note.create` | FR-NOTE-001 |
| `GET /promises` · `POST /promises` · `POST /promises/{id}/cancel` | `promise.view` / `promise.create` | FR-PRM-001 |
| `POST /attendance/events` · `GET /attendance/me/today` | `attendance.record` | FR-ATT-001 |
| `GET /attendance/days` · `GET /attendance/summary` · `POST /attendance/corrections` | `attendance.view` / `attendance.manage` | FR-ATT-004/006 |
| `POST /leave-requests` · `GET /leave-requests` · `POST /leave-requests/{id}/decision` · `POST /leave-requests/{id}/cancel` (own pending, 1.12.0) | `leave.request` / `attendance.manage` | FR-ATT-008 |
| `POST /location/points` · `POST /location/heartbeat` | auth (staff on duty); points also with `Authorization: Tracking <token>` (1.49.0) | FR-LOC-001..004/010, FR-LOC-013 |
| `POST /location/tracking-token` (staff app session with a device; 1.49.0, ADR-067) | `attendance.record` | FR-LOC-013 |
| `GET /location/latest` | `location.view` | FR-LOC-006 |
| `GET /location/history` · `GET /location/stops` | `location.history.view` | FR-LOC-007/008 |
| `GET /sync/pull` · `POST /sync/push` · `GET /sync/bootstrap` | auth (scope) | FR-SYNC-* |
| `GET /notifications` · `POST /notifications/{id}/read` · `POST /notifications/read-all` | auth | FR-NOT-003 |
| `POST /broadcasts` · `GET /broadcasts` · `POST /broadcasts/{id}/ack` · `GET /broadcasts/{id}/recipients` (1.12.0) | `notification.broadcast` / auth | FR-NOT-005 |
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
Errors: `401 INVALID_CREDENTIALS`, `423 ACCOUNT_LOCKED`, `403 DEVICE_NOT_APPROVED` (FR-AUTH-007), `426 UPGRADE_REQUIRED`. Bodies since 1.47.0 (ADR-064):
```json
423 Locked   Retry-After: 840
{ "type": "https://errors.howlader.app/account-locked", "title": "Account temporarily locked", "status": 423,
  "code": "ACCOUNT_LOCKED", "requestId": "0193…",
  "details": { "until": "2026-11-24T04:15:00.000Z", "retryAfterSec": 840, "scope": "account" } }

403 Forbidden
{ "type": "https://errors.howlader.app/device-not-approved", "title": "Device waiting for manager approval", "status": 403,
  "code": "DEVICE_NOT_APPROVED", "requestId": "0193…",
  "details": { "pendingDeviceId": "6742b0…", "deviceId": "a1b2c3d4e5f60718", "status": "pending_approval", "maxActiveDevices": 1 } }
```
`scope: account` = 5 wrong passwords for this phone/username in 15 min. `scope: ip` = too many failures from this network (`auth.ipLockFailures`, default 50) and this device/browser never had a session of the user; a known device still logs in.

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
`410 CURSOR_EXPIRED` → client calls `GET /sync/bootstrap` (full scope snapshot, paged). Sent for a cursor ahead of the feed, older than the 30-day window, or below a resync floor: the server raises one when it widens what devices may hold (1.20.1: branch-wide customers, ADR-038), so devices that took their snapshot under the old rule reload once.

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

### 3.10 Map pins (1.11.0)
A manager drops the pin on the map:
```http
POST /api/v1/customers/6731…/location
{ "clientId": "01936f0e-…", "lat": 22.73012, "lng": 90.38011, "note": "From the shop sign board" }
```
→ `201 { "id": "6741…", "status": "approved", "location": { "lat": 22.73012, "lng": 90.38011, "status": "overridden", "source": "overlay" } }`; the same `clientId` again → `200` with the same body.

A field staff member picks the pin on the map (the phone was 180 m away):
```http
POST /api/v1/customers/6731…/location-proposals
{ "clientId": "01936f0f-…", "method": "map", "geo": { "lat": 22.7112, "lng": 90.3712, "accuracyM": 0 },
  "deviceGeo": { "lat": 22.7128, "lng": 90.3712, "accuracyM": 14 }, "note": "Blue gate behind the mosque" }
```
→ `201 { "id": "6742…", "status": "approved" }` when the customer had no usable pin and `customers.staffPinApproval` is `when_missing` (default); otherwise `"status": "pending"` until a manager decides. The same body goes through `/sync/push` as mutation `location_proposal` (+ `customerId`).

1.39.0 (FR-CUS-020, ADR-052): the same call by a super admin or branch manager (anyone holding `customer.location.approve` for the customer's branch) moves the pin at once, even when the customer already had one:
→ `201 { "id": "6743…", "status": "approved", "direct": true }`. Field staff get `"direct": false`. On `/sync/pull` the `location_proposal` item carries `status: approved`, `direct: true` and `decider` = the caller.

### 3.9b Paid this month (1.29.0, FR-CUS-019)
Customers of one branch who have not paid anything this Dhaka month, longest overdue first, with the count:
```http
GET /api/v1/customers?branchId=6730…&paidThisMonth=no&sort=-daysOverdue&includeTotal=true
```
→ a normal `CustomerPage`; every row's `activity.paidPoisha` and `activity.pendingPoisha` are 0. `paidThisMonth=yes` gives the others (an ERP payment dated this month, or a field collection of this month not yet in the ERP). Works on `/customers/map` too; any other value is a 400.

### 3.9b2 Who did this month's work (1.44.0, FR-CUS-021)
Every customer row, detail and sync `customer` item carries the names behind `activity`:
```json
"activity": {
  "month": "2026-11", "visitCount": 2, "visitedToday": true, "lastVisitAt": "2026-11-15T04:00:00.000Z",
  "paidPoisha": 65000, "lastPaidDate": "2026-11-12", "pendingPoisha": 50000,
  "promisesMade": 2, "promisesKept": 0, "promisesBroken": 0,
  "visitedBy": [ { "userId": "6702…", "name": "Sumon Mia", "count": 1, "lastAt": "2026-11-15T04:00:00.000Z" },
                 { "userId": "6701…", "name": "Rakib Hasan", "count": 1, "lastAt": "2026-11-15T03:30:00.000Z" } ],
  "paidBy": [ { "name": "Rakib Hasan", "source": "staff", "userId": "6701…", "amountPoisha": 50000, "lastDate": "2026-11-15", "pending": true },
              { "name": "Office Clerk", "source": "erp_referrer", "amountPoisha": 20000, "lastDate": "2026-11-12", "pending": false },
              { "name": "Rakib Hasan", "source": "staff", "userId": "6701…", "amountPoisha": 30000, "lastDate": "2026-11-10", "pending": false },
              { "name": "Unlinked Collector", "source": "collector_name", "amountPoisha": 10000, "lastDate": "2026-11-08", "pending": false },
              { "name": "", "source": "unknown", "amountPoisha": 5000, "lastDate": "2026-11-02", "pending": false } ],
  "promisedBy": [ { "userId": "6703…", "name": "Manager A", "count": 1, "lastAt": "2026-11-15T05:00:00.000Z" },
                  { "userId": "6701…", "name": "Rakib Hasan", "count": 1, "lastAt": "2026-11-15T03:31:00.000Z" } ],
  "lastVisitByName": "Sumon Mia", "lastPaidByName": "Rakib Hasan"
}
```
`paidBy` entries with `pending: false` add up to `paidPoisha`, those with `pending: true` to `pendingPoisha`; never add the two. The home list says "promised by" from `openPromise.createdByName` (filled on list rows since 1.44.0). The row also has `lastVisitByName` (who made the visit at `lastVisitAt`), and each `payments[]` item has `referrerName` (the ERP referrer employee, null without one).

### 3.9c Deposit detail and the promise behind a cash line (1.30.0, FR-CASH-008)
```http
GET /api/v1/cash/deposits/6745…/collections
```
→ `{ "deposit": { "id": "6745…", "amountPoisha": 600000, "status": "pending", "userName": "Rakib Hasan", … }, "coveredPoisha": 600000, "unmatchedPoisha": 0,
  "items": [ { "collectionId": "6740…", "receiptNo": "BRL01-FS014-261115-0002", "businessDate": "2026-11-15", "customer": { "id": "6731…", "code": "100246", "name": { … } }, "erpPlanId": "9921", "amountPoisha": 500000, "inHandPoisha": 0, "coveredPoisha": 500000, "status": "posted",
                 "promise": { "id": "6744…", "promisedDate": "2026-11-15", "promisedAmountPoisha": 500000, "status": "kept", "onTime": true } },
               { "…": "the next collection, covered in part", "amountPoisha": 350000, "coveredPoisha": 100000, "promise": null } ], "generatedAt": "…" }`
The same `promise` field is on every line of `GET /cash/me/collections` and `/cash/positions/{id}/collections`.

### 3.9d Who did it, for the whole branch (1.31.0, FR-ACT-002, ADR-046)
Staff read every visit, promise, collection and pin of their branch, each with the person who did it. Writes stay with the owner.
```http
GET /api/v1/visits?customerId=6731…          (field_staff of the same branch)
```
→ `{ "items": [ { "id": "6746…", "userId": "6720…", "userName": "Rakib Hasan", "outcome": "promised", … } ] }`
- `Visit.userName`, `Promise.ownerName` (the customer's assignee), `Promise.createdBy` + `createdByName` (who made it), `Collection.collector {id,name}` (unchanged), `OwnLocationProposal.proposer {id,name}` / `decider {id,name}|null` / `direct`.
- Sync: visit, promise, collection and location_proposal changes now reach every device of the branch (`fanoutBranchId`); each loader still applies the caller's scope, so another branch gets a tombstone. `GET /sync/bootstrap` brings the branch's last 60 Dhaka days (promises: open ones too; collections now have a snapshot; location_proposal: pending and the last 60 days, at most 500).
- Devices that synced before 1.31.0 get `410 CURSOR_EXPIRED` once (resync floor `branch-wide-activity`) and take a fresh snapshot; the outbox is kept.
- Changing a colleague's record (visit checkout, promise cancel, collection void/resolve) answers `404`.

### 3.9e Withdraw or correct a cash collection, delete a deposit (1.32.0, FR-COL-016, FR-CASH-009)
```http
POST  /api/v1/collections/6750…/withdraw     { "reason": "wrong customer" }      (collection.withdraw, own cash only)
PATCH /api/v1/collections/6750…              { "amountPoisha": 350000, "note": "corrected" }   (collection.edit)
POST  /api/v1/cash/deposits/6751…/delete     { "reason": "entered twice by mistake" }          (cash.deposit.delete)
```
- Withdraw → `200` the collection with `status: "voided"` and `voided {by, at, reason}`; a repeat by the same person answers the same. Edit → `200` the collection; the same values again change nothing.
- `409 INVALID_STATE` `details.reason`: `NOT_CASH`, `COVERED_BY_DEPOSIT` (a pending or verified deposit covers it), `NOT_EDITABLE` (edit: not `received`, or the ERP already got an attempt), `ALREADY_POSTED_OR_CLOSED`, `USE_RESOLVE` (status `conflict`), `POSTING_IN_PROGRESS`, `STATUS_CHANGED`. A deposit that is already `rejected` or `deleted` → `NOT_DELETABLE`. Another staff member's collection is `404`.
- Deposit `status` gains `deleted` with `deletedBy`, `deletedAt`, `deleteReason`; it counts in no total and covers no collection. The depositor gets a notification of type `cash.deposit.deleted`; a collection voided by the office (not by its collector) notifies the collector with type `collection.voided`.
- Offline: sync mutation entities `collection_withdraw` `{ collectionId | clientId, reason? }` and `collection_edit` `{ collectionId | clientId, amountPoisha?, note?, payerName? }` (send after the collection; `clientId` resolves the collector's own collection).

### 3.9f Photos in Cloudinary; deleting photos (1.37.0, FR-MED-002..004, ADR-050)
```http
GET  /api/v1/media/purge/preview                     (media.delete; default before = this Dhaka month)
→ 200 { "before": "2026-12", "cutoff": "2026-11-30T18:00:00.000Z", "today": "2026-12-06", "kinds": ["selfie","visit_photo","location_proof"],
        "includeMoneyProofs": false, "months": [{ "month": "2026-10", "count": 412, "bytes": 98304000 }, { "month": "2026-11", "count": 388, "bytes": 91750400 }],
        "total": { "count": 800, "bytes": 190054400 }, "suggest": true }
POST /api/v1/media/purge { "before": "2026-12", "confirmText": "DELETE 2026-12" }
→ 200 { "deleted": 200, "bytes": 47513600, "remaining": 600 }     … repeat until "remaining": 0
POST /api/v1/attendance/photos/delete { "userId": "6740…", "date": "2026-11-21", "reason": "privacy request" }
→ 200 { "deleted": 2, "events": [{ "id": "…", "type": "work_in", "selfieMediaId": null, "selfieDeleted": { "at": "2026-11-22T06:10:00Z", "by": "6739…", "byName": "Owner" }, … }] }
```
- A wrong `confirmText` → `422 BUSINESS_RULE` `details.rule = CONFIRM_TEXT_MISMATCH` (`details.expected` names the text); a month after the current one → `422` `NOT_A_PAST_MONTH`. Deposit slips and refund proofs only with `includeMoneyProofs: true`.
- `GET /media/{id}/url` of a deleted photo → `404 NOT_FOUND` `details { reason: "MEDIA_DELETED", deletedAt, deletedByName }`; `POST /media/upload-url` with the same file → `409 INVALID_STATE` `MEDIA_DELETED`.
- With Cloudinary configured, `GET /media/{id}/url` of a copied photo returns `https://api.cloudinary.com/v1_1/<cloud>/image/download?public_id=…&format=jpg&type=authenticated&timestamp=…&expires_at=…&api_key=…&signature=…` (5 minutes). Before the copy, the link points at the server's store as before.

### 3.9g Map places (1.38.0, FR-PLC-001..006, ADR-051; all branches since 1.42.0, ADR-054)
```http
POST /api/v1/places   (place.create)
{ "clientId": "2f0c…", "name": "Karim Store", "icon": "shop", "note": "Blue gate, next to the tea stall", "location": { "lat": 22.7012, "lng": 90.3711 } }
→ 201 { "id": "6752…", "clientId": "2f0c…", "branchId": "6731…", "name": "Karim Store", "icon": "shop", "note": "Blue gate, next to the tea stall",
        "location": { "lat": 22.7012, "lng": 90.3711 }, "status": "active", "version": 1, "pendingMove": null, "lastMoveDecision": null,
        "createdBy": { "id": "6740…", "name": "Rakib Hasan" }, "updatedBy": { "id": "6740…", "name": "Rakib Hasan" },
        "createdAt": "2026-11-22T04:00:00.000Z", "updatedAt": "2026-11-22T04:00:00.000Z", "deletedAt": null, "deleteReason": null,
        "events": [{ "type": "created", "by": { "id": "6740…", "name": "Rakib Hasan" }, "at": "2026-11-22T04:00:00.000Z", "note": null, "from": null, "to": { "lat": 22.7012, "lng": 90.3711 } }] }
GET   /api/v1/places?bbox=90.36,22.69,90.38,22.71&q=karim&icon=shop            (place.view; every branch's places since 1.42.0; `branchId` only narrows)
PATCH /api/v1/places/6752…   If-Match: W/"1"   { "name": "Karim General Store" }  (creator, or place.manage; `location` only with place.manage)
POST  /api/v1/places/6752…/move-request   { "clientId": "91ab…", "location": { "lat": 22.7022, "lng": 90.3711 }, "reason": "The shop is across the road" }
→ 201 { …, "location": { "lat": 22.7012, "lng": 90.3711 }, "pendingMove": { "location": { "lat": 22.7022, "lng": 90.3711 }, "requestedBy": { "id": "6741…", "name": "Sumon Mia" },
        "requestedAt": "…", "reason": "The shop is across the road", "distanceM": 111 } }
GET   /api/v1/places/move-requests          (place.manage) → { "items": [ Place, … ] } oldest request first
POST  /api/v1/places/6752…/move-request/decision { "decision": "reject", "reason": "The gate is on this side" }   (place.manage)
DELETE /api/v1/places/6752…?reason=Shop%20closed%20down                                                        (place.manage)
```
- A repeat of the same `clientId` (create or move request) answers `200` with the place as it is; a field staff member editing someone else's place or sending `location` → `403 FORBIDDEN` `details { permission: "place.manage", reason: NOT_OWNER | MOVE_NEEDS_MANAGE }`.
- `409 INVALID_STATE` `details.reason`: `MOVE_PENDING` (another open request), `NO_PENDING_MOVE`, `PLACE_DELETED` (office only; staff get 404), `PLACE_CHANGED` (lost a race, read again). `412` stale `If-Match`. `422 BUSINESS_RULE`: `OUTSIDE_BANGLADESH`, `MOVE_TOO_SHORT` (< 5 m), `REASON_REQUIRED` (reject under 5 characters).
- Offline: sync mutations `place` (PlaceCreate), `place_edit` `{ placeId | placeClientId, name?, icon?, note?, location? }` (`location` since 1.43.0: a direct move, place.manage only, same rules as PATCH; otherwise the item is rejected `FORBIDDEN` `MOVE_NEEDS_MANAGE`), `place_move_request` `{ placeId | placeClientId, clientId, location, reason? }`; results carry `entityId` (the server id) and `version`. Sync entity `place` goes to every device of every branch (1.42.0); a deleted place arrives as `op: delete`, `reason: deleted`.
- Notifications: `place.move_request` (to everyone with `place.manage` in any branch since 1.42.0, `data.placeId`), `place.move_decided` (to the requester, `data { placeId, decision }`). Inbox item type `place.move_request`, link `/places/move-requests`, shown to every `place.manage` holder in any branch (1.42.0).
- 1.42.0 (ADR-054): a place needs no branch. `branchId` in the create body is ignored (no more `PLACE_INVALID_BRANCH`); `Place.branchId` is the adder's first branch for information (`''` when none). Office actions with `place.manage` work on any branch's place; staff edit rules are unchanged.

### 3.9h Dashboard, follow-ups, possible customers, attendance exemption (1.45.0, FR-DSH-002, FR-PRM-006, FR-PRO-001, FR-ATT-014)
```http
GET /api/v1/dashboard/overview?branchId=6731…&from=2026-11-01&to=2026-11-23   (report.view)
→ 200 { …fields of 1.44.0…, "range": { "from": "2026-11-01", "to": "2026-11-23", "days": 23 },
        "collections": { "today": { "amountPoisha": 220000, "count": 3, "link": { "path": "/collections", "query": { "branchId": "6731…", "from": "2026-11-23", "to": "2026-11-23" } } },
                         "byMethod": [ { "method": "cash", "amountPoisha": 1800000, "count": 41, "link": { "path": "/collections", "query": { "branchId": "6731…", "from": "2026-11-01", "to": "2026-11-23", "method": "cash" } } } ], … },
        "promiseStats": { "brokenWithoutFollowUp": { "count": 4, "link": { "path": "/promises", "query": { "branchId": "6731…", "from": "2026-11-01", "to": "2026-11-23", "brokenWithoutFollowUp": "true" } } }, "keptRate": 0.62, … },
        "attendanceToday": { "present": { "count": 12, "link": { "path": "/attendance/days", "query": { "from": "2026-11-23", "to": "2026-11-23" } } }, … }, … }

POST /api/v1/promises   (promise.create; also sync mutation `promise`)
{ "clientId": "0193…", "customerId": "6750…", "promisedDate": "2026-11-27", "promisedAmountPoisha": 150000, "followUpOf": "6761…" }
→ 201 { "id": "6770…", "followUpOf": "6761…", "followUpId": null, "attempt": 2, "chainRootId": "6761…", "status": "open", … }
→ 422 { "code": "BUSINESS_RULE", "details": { "rule": "PROMISE_FOLLOW_UP_INVALID", "reason": "NOT_BROKEN", "followUpOf": "6761…" } }
GET  /api/v1/promises?brokenWithoutFollowUp=true&from=2026-11-01&to=2026-11-23
GET  /api/v1/promises?from=2026-11-23&to=2026-11-30&createdBy=6740…          (next 7 days, made by one person)

POST /api/v1/prospects   (prospect.create; also sync mutation `prospect`)
{ "clientId": "0193…", "name": "Jamal Uddin", "phones": [ { "number": "01712345678" } ], "address": "Near the ghat", "location": { "lat": 22.70, "lng": 90.37, "accuracyM": 12 } }
→ 201 { "id": "6780…", "status": "new", "phones": [ { "number": "+8801712345678", "label": null } ], "createdBy": { "id": "6740…", "name": "Rakib Hasan" }, "history": [ { "status": "new", … } ], "version": 1, … }
PATCH /api/v1/prospects/6780…            { "status": "contacted", "reason": "Called, will visit the shop" }   (prospect.manage)
POST  /api/v1/prospects/6780…/convert    { "erpCustomerCode": "BRL01-100245" }                                  (prospect.manage)
POST  /api/v1/prospects/6780…/reopen     { "reason": "Bought once, wants a second item" }                       (prospect.manage)
GET   /api/v1/prospects?status=new&from=2026-11-01&to=2026-11-23&q=jamal
```
- `link` opens the list behind a number: `GET /api/v1{path}?{query}`. A few lists lack an exact filter (collections take one status; attendance days have no status filter); the link then opens the nearest list.
- `attendanceRequired` (login, refresh, `/auth/me`, sync bootstrap/pull): false → the app hides attendance. Super admins hold `attendance.exempt`.
- `GET /inbox` and `GET /activity` take `from` / `to` (inclusive Dhaka dates). Visit rows carry `businessDate` and `checkInLocalTime` ("HH:mm").
- `POST /media/upload-url`: `capturedAt` without `Z`/offset is read as Asia/Dhaka time.

### 3.9i Customer list pages of up to 1000 and page jumps (1.46.0, FR-CUS-022)
```http
GET /api/v1/customers?limit=1000&offset=2000&sort=name&includeTotal=true      (customer.view; page 3 of 1000)
→ 200 { "items": [ …1000 CustomerListItem… ], "nextCursor": "eyJvIjozMDAwfQ", "total": 4312, "invoiceTotals": { … } }
GET /api/v1/customers?limit=500&offset=1500&filter=overdue&branchId=6731…     (page 4 of 500, any filter)
GET /api/v1/customers?limit=100&offset=99999                                 → 200 { "items": [], "nextCursor": null }
GET /api/v1/customers?limit=1001  |  ?offset=-1  |  ?offset=1.5              → 400 VALIDATION_FAILED
```
- `offset` is 0-based (page N of size L = `offset=(N-1)*L`) and wins over `cursor`; without it the cursor works as before. `nextCursor` is still returned, so "next page" keeps working for existing clients. Default `limit` stays 50.
- Every sort ends with `_id`, so pages never overlap or skip a row while the data does not change (rows that change between two calls can move, as with any offset pager). `sort=distance` pages only the nearest 2000 in the radius.
- `total` (with `includeTotal=true`) is the exact number of matches; it was capped at 10,000 before.

### 3.9j Device approvals (1.47.0, FR-AUTH-007, ADR-064)
```
GET  /api/v1/devices?userId=6734a1…   → [ { "id": "6742b0…", "deviceId": "a1b2…", "model": "Redmi 9A", "androidVersion": "android 10",
                                           "status": "pending_approval", "likelyReinstall": true, … },
                                         { "id": "6731ff…", "status": "active", "likelyReinstall": false, … } ]
POST /api/v1/devices/6742b0…/approve  → 200 { "id": "6742b0…", "status": "active" }   (old active phone unbound, its sessions end)
POST /api/v1/devices/6742b0…/approve  → 200 { "id": "6742b0…", "status": "active" }   (again: nothing changes)
```
Who is bound (1.51.0, ADR-068): on `client: app`, every role **except** the roles in setting `devices.multiDeviceRoles` (default `["super_admin"]`); a role added later is bound without editing the setting. `client: web` is never bound. `devices.bindRoles` is deprecated (still listed by `GET /settings`, no longer read).
```
PATCH /api/v1/settings { "changes": { "devices.multiDeviceRoles": ["super_admin"] }, "reason": "…" }   (array of role names; unknown role → 400)
POST  /api/v1/auth/login  (branch manager, 2nd phone)  → 403 { "code": "DEVICE_NOT_APPROVED", "details": { "pendingDeviceId": "…", "status": "pending_approval", "maxActiveDevices": 1 } }
POST  /api/v1/auth/logout (super admin, phone 1)       → 204   (phone 1's session and tracking token end; phone 2 keeps both)
```
A user who already had more active devices than `devices.maxPerUser` (rows made by the push-token registration while their role was not bound) keeps the phone they log in with; the others are unbound, their sessions end, and their next login is a pending device (audit `device.unbound`, reason `device_limit`).
- `likelyReinstall` is false unless the setting `devices.reinstallHintIdleDays` is above 0: then it is true for a pending device with the same model and Android version as the user's only active device, when that device was not seen for that many days. Only a hint; the admin still approves.

### 3.9k Area manager (1.48.0, FR-USER-003, ADR-065)
```
POST /api/v1/users  (super admin)  { "name": { "en": "Area Manager", "bn": "এরিয়া ম্যানেজার" }, "phone": "01700000007",
                                     "role": "area_manager", "branchIds": ["6731…"], "employeeCode": "AM001" }
→ 201 { "user": { "role": "area_manager", "branchIds": ["6731…"], … }, "temporaryPassword": "…" }
POST /api/v1/users/6734…/reset-password  (area manager) → 403 { "code": "FORBIDDEN", "details": { "permission": "user.manage" } }
PUT  /api/v1/rbac/overrides/user/<areaManagerId> { "changes": [ { "key": "user.manage", "effect": "allow" } ], "reason": "…" }
→ 422 { "code": "BUSINESS_RULE", "details": { "rule": "PERMISSION_NOT_GRANTABLE", "key": "user.manage", "role": "area_manager" } }
GET  /api/v1/rbac/permissions → [ { "key": "settings.manage", "defaults": { "super_admin": true }, "neverFor": ["area_manager"], … }, … ]
```
- Scope is every branch (like the super admin); `branchIds[0]` is only the home branch. Permissions: the AM column of 02-requirements §3.1. Device-bound in the staff app since 1.51.0 (ADR-068: every role except `devices.multiDeviceRoles`, default `["super_admin"]`); web logins are not bound.

### 3.9l Requests / tickets (1.48.0, FR-REQ-001..006, ADR-066)
```
POST /api/v1/requests  (or sync mutation `request`)
{ "clientId": "5f0c…", "type": "complaint", "priority": "important", "title": "Customer threatened me",
  "body": "At the bazaar shop, 11:00", "customerId": "6741…", "photoMediaIds": ["6750…"] }
→ 201 { "id": "6760…", "status": "open", "level": "super_admin", "currentQueue": "super_admin", "assignee": null,
        "timeline": [ { "id": "…", "kind": "created", "at": "2026-11-24T05:00:00.000Z", "actor": { "id": "6734…", "name": "Rakib Hasan" },
                        "note": null, "from": null, "to": { "queue": "super_admin", "user": null }, "status": { "from": null, "to": "open" } } ], … }
POST /api/v1/requests/6760…/assign   { "userId": "6735…", "note": "Visit with him tomorrow" }
→ 200 { "status": "in_progress", "currentQueue": "assignee", "level": "super_admin", "assignee": { "id": "6735…", "name": "Sumon Mia" }, … }
POST /api/v1/requests/6760…/comment  { "clientId": "8a1e…", "text": "Going at 10" }        (or sync mutation `request_comment`
                                                                                          { "requestClientId": "5f0c…", "clientId": "8a1e…", "text": "…" })
POST /api/v1/requests/6760…/resolve  { "note": "Spoke with the customer and his family" }  → 200 { "status": "resolved", … }
POST /api/v1/requests/6760…/forward  { "queue": "area_manager", "note": "…" }             → 409 INVALID_STATE (reason REQUEST_RESOLVED)
GET  /api/v1/requests?status=open,in_progress,forwarded,reopened&queue=area_manager&from=2026-11-01&to=2026-11-24
→ 200 { "items": [ … ], "nextCursor": null, "total": 3, "counts": { "open": 2, "in_progress": 0, "forwarded": 1, "resolved": 4, "closed": 1, "reopened": 0 } }
```
- `level` = who is responsible (set by priority, changed by forwarding to a queue); `currentQueue` = where it waits now. At `super_admin` level only `request.important.manage` moves, resolves or closes it (else 403 FORBIDDEN `details.permission = request.important.manage`); the assignee may resolve; the creator may reopen or close their own.
- `409 INVALID_STATE` `details.reason`: `REQUEST_RESOLVED`, `REQUEST_CLOSED`, `REQUEST_OPEN` (reopen of an open request), `REQUEST_CHANGED` (lost a race: read again). `422 BUSINESS_RULE` `REQUEST_INVALID_TARGET` (forward/assign to an unknown or inactive user, or one without request.create / request.manage).
- Dashboard: `requestStats { areaManagerQueue, superAdminQueue, assigned, importantOpen }`, each `{ count, link }` to `GET /requests`.

### 3.9m Audit log by Dhaka date (1.48.0, FR-AUD-003)
```
GET /api/v1/audit?from=2026-11-24&to=2026-11-24&action=request.*&branchId=6731…
```
- A date is inclusive Asia/Dhaka: `from` = 00:00 Dhaka (18:00 UTC the day before), `to` = the end of that Dhaka day. A date-time is still an exact instant. `from` after `to`, or anything else → 400.

### 3.9n Tracking token for the native location service (1.49.0, FR-LOC-013, ADR-067)
```http
POST /api/v1/location/tracking-token          (Bearer access token of the app session, X-Device-Id)
→ 200 { "token": "trk_3q2X…", "expiresAt": "2026-11-27T04:00:00.000Z" }

POST /api/v1/location/points                  (from LocationTrackingService, app closed, access token long expired)
Authorization: Tracking trk_3q2X…
Content-Encoding: gzip
{ "deviceId": "<same device>", "points": [ … ] }
→ 200 { "accepted": 1, "rejected": [], "nextSampling": { … } }
```
- Any other route with that header → `401 { "code": "UNAUTHENTICATED", "details": { "reason": "TRACKING_TOKEN_NOT_ALLOWED" } }`.
- Rotated, revoked (logout, password reset, deactivation, device unbind, session ended), session or user gone, device not approved → `401 … "reason": "TRACKING_TOKEN_INVALID"`; past `expiresAt` → `"TRACKING_TOKEN_EXPIRED"`. The native service does **not** refresh: it keeps the points buffered and retries with whatever token is stored at the next cycle.
- A web session or an app session without a device → `403 FORBIDDEN { "reason": "APP_ONLY" }`; no `attendance.record` → `403 FORBIDDEN { "permission": "attendance.record" }`.

### 3.10a Pin colours and invoice viewer (1.14.0)
Yellow and orange pins of credit customers in view:
```http
GET /api/v1/customers/map?bbox=90.30,22.10,90.45,22.20&zoom=15&payState=missed_one,missed_many&invoiceKind=credit
```
→ `{ "pins": [ { "id": "6731…", "lat": 22.16, "lng": 90.42, "status": "overdue", "payState": "missed_one", "missedCount": 1, "name": "…", "outstandingPoisha": 600000, "tagged": false } ], "clusters": [] }`. Zoomed out, each cluster has `worstPayState` and `payStates` (`{ "bad": 3, "on_track": 12 }`).

One installment line in `GET /customers/{id}` → `plans[].schedule[]`:
```json
{ "seq": 2, "dueDate": "2026-09-05", "amountPoisha": 516233, "paidPoisha": 516233, "outstandingPoisha": 0, "status": "paid",
  "paidOn": "2026-11-12", "daysLate": 68, "missed": false,
  "payments": [ { "erpPaymentId": "30411", "receiptNo": "PAY-20261014-00012", "date": "2026-10-14", "amountPoisha": 483767 },
                { "erpPaymentId": "30502", "receiptNo": "PAY-20261112-00031", "date": "2026-11-12", "amountPoisha": 32466 } ] }
```
A credit plan has `kind: "credit"`, `creditDueDate`, one schedule line on that date, and no `penalty`.

### 3.10b Staff see the whole branch, staff in several branches (1.19.0)
An admin lets a Barishal staff member also work in Patuakhali (the first branch stays the home branch):
```http
PATCH /api/v1/users/6740…
{ "branchIds": ["<BRL01 id>", "<PTK01 id>"], "reason": "covers Patuakhali too" }
```
→ `200` user. On the next `GET /sync/pull` that staff member's phone receives every Patuakhali customer (and loses them again when the branch is removed). `GET /customers` as that staff member lists both branches, each row with `"branch": { "id": "…", "code": "PTK01", "name": { "bn": "পটুয়াখালী", "en": "Patuakhali" } }` and `assignee` when someone owns it; `GET /customers?assignedTo=me` is their own work list. A branch that wants the old rule sets `PATCH /settings { "branchId": "…", "changes": { "customers.staffVisibility": "assigned" }, "reason": "…" }`.

### 3.11 Leave, holidays, shifts, notices, guarantor calls (1.12.0)
A staff member withdraws a request with wrong dates, then asks again:
```http
POST /api/v1/leave-requests/6750…/cancel
```
→ `200 { "id": "6750…", "status": "cancelled", "cancelledAt": "2026-11-17T12:40:00.000Z", "from": "2026-11-24", "to": "2026-11-26", "days": 3, … }`; a decided request → `409 INVALID_STATE` `ALREADY_DECIDED`.

A manager looks at who is on leave this month: `GET /leave-requests?from=2026-11-01&to=2026-11-30&status=approved` (requests overlapping the window). A rejected request carries `decisionReason` for the staff member.

The phone shows the staff member's own shift: `GET /attendance/me/shift` → `200 { "id": "default", "name": "Default", "start": "09:00", "end": "18:00", "weeklyOff": [5], "lateGraceMin": 15, "maxBreakMin": 60, "breakWindows": [] }`; holidays that apply to them: `GET /calendar/holidays?year=2026&branchId=…`. An admin deletes a holiday entered by mistake: `DELETE /calendar/holidays/6760…` → `204`.

What staff are doing (1.28.0): `GET /activity?limit=30` → `200 { "items": [{ "id": "67a0…", "type": "collection", "at": "2026-11-15T04:02:00.000Z", "branchId": "6701…", "actor": { "id": "6702…", "name": { "bn": "রাকিব হাসান", "en": "Rakib Hasan" }, "employeeCode": "FS014" }, "customer": { "id": "6710…", "name": { … }, "code": "C-100246" }, "entity": "collection", "entityId": "6750…", "data": { "amountPoisha": 150000, "method": "cash" }, "unseen": true }, …], "unseen": 4, "seenAt": null, "nextCursor": null }`; the admin opened the bell: `POST /activity/seen` → `200 { "seenAt": "…", "unseen": 0 }`.

Where the cash in hand came from (1.27.0): `GET /cash/positions/6702…/collections` → `200 { "userId": "6702…", "userName": "Rakib Hasan", "onHandPoisha": 350000, "pendingDepositsPoisha": 600000, "count": 2, "items": [{ "collectionId": "6750…", "receiptNo": "BRL01-FS014-261115-0004", "recordedAt": "2026-11-15T03:10:00.000Z", "businessDate": "2026-11-15", "customer": { "id": "6710…", "name": { "bn": "…", "en": "…" }, "code": "C-100246" }, "erpPlanId": "9001", "amountPoisha": 100000, "inHandPoisha": 100000, "status": "received" }, { …, "amountPoisha": 350000, "inHandPoisha": 250000 }], "generatedAt": "…" }`; the staff member's own list: `GET /cash/me/collections`.

The collection board (1.26.0): `GET /reports/collection-board?period=month` → `200 { "period": "month", "month": "2026-11", "scope": "all", "branchId": null, "generatedAt": "2026-11-21T04:00:00.000Z", "items": [{ "rank": 1, "userId": "6702…", "name": { "bn": "রাকিব হাসান", "en": "Rakib Hasan" }, "employeeCode": "FS014", "role": "field_staff", "branchId": "6701…", "postedPoisha": 220000, "count": 3, "me": true }, …], "me": { "rank": 1, "of": 2, "postedPoisha": 220000 } }`; all time: `?period=all` (`"month": null`). Money still pending in the ERP is not in `postedPoisha`.

Duty hours per branch (1.25.0). A branch that works every day and has a long Friday break: `PATCH /settings { "branchId": "6701…", "changes": { "attendance.defaultShift": { "start": "09:00", "end": "18:00", "weeklyOff": [], "lateGraceMin": 15, "maxBreakMin": 60, "breakWindows": [{ "weekday": 5, "start": "12:30", "end": "15:30" }] } }, "reason": "Friday break, no weekly off day" }` → `200`. A branch whose off day is Saturday sends `"weeklyOff": [6]` and no window. A wrong value → `400 VALIDATION_FAILED` with the part named (`attendance.defaultShift.breakWindows.0.end`). A Friday in the first branch with a break from 12:30 to 15:30 and work-out at 20:00: `{ "breakMin": 180, "overBreakMin": 0, "overtimeMin": 120, "flags": ["overtime"], … }`. The month: `GET /attendance/summary?month=2026-11` → rows with `"late": 2, "lateAbsences": 1, "overtimeMin": 120, "overtimeDays": 1, "offDaysWorked": 0, "overBreakMin": 0, …`.

A staff member taps "পড়েছি" on a notice while offline; on the next sync:
```json
{ "mutationId": "01936f2a-…", "entity": "broadcast_ack", "op": "create", "payload": { "broadcastId": "6770…", "at": "2026-11-17T04:05:00Z" } }
```
The sender sees it: `GET /broadcasts/6770…/recipients` → `{ "recipientCount": 12, "ackCount": 9, "items": [ { "userId": "…", "name": { "bn": "সুমন মিয়া", "en": "Sumon Mia" }, "employeeCode": "FS015", "acked": false }, …, { …, "acked": true, "ackedAt": "2026-11-17T04:05:00.000Z" } ] }` (not read first).

A call to the guarantor is logged like any contact attempt with `"target": "guarantor"` (REST or sync `contact_attempt`); the customer timeline says "জামিনদারকে কল".

## 4. Error codes

| HTTP | code | Meaning / client behaviour |
|---|---|---|
| 400 | `VALIDATION_FAILED` | `details.fields[]` per field; show inline. |
| 401 | `UNAUTHENTICATED` / `TOKEN_EXPIRED` | Refresh then retry once. With a tracking token (1.49.0): `details.reason` `TRACKING_TOKEN_INVALID` / `TRACKING_TOKEN_EXPIRED` / `TRACKING_TOKEN_NOT_ALLOWED`; never refresh from the native service, keep points buffered. |
| 401 | `INVALID_CREDENTIALS` | Show generic message. |
| 401 | `REFRESH_REUSED` | Session family revoked → force login. |
| 403 | `FORBIDDEN` | Missing permission (`details.permission`). |
| 403 | `FEATURE_DISABLED` | Hide feature; refresh flags. |
| 403 | `DEVICE_NOT_APPROVED` | Show "waiting for manager approval" with `details.pendingDeviceId` and `requestId` (1.47.0). Retrying does not create a new request. |
| 403 | `PASSWORD_CHANGE_REQUIRED` | Route to change password. |
| 404 | `NOT_FOUND` | Also used for out-of-scope resources. |
| 409 | `IDEMPOTENCY_MISMATCH` | Bug or tampering; log, do not retry. |
| 409 | `INVALID_STATE` | e.g. accept an expired handover, break_end without break_start. |
| 409 | `DUPLICATE_RECEIPT_NO` | Device sequence problem → request new block. |
| 410 | `CURSOR_EXPIRED` | Bootstrap. |
| 412 | `PRECONDITION_FAILED` | Reload and retry edit. |
| 413 | `PAYLOAD_TOO_LARGE` | Split batch. |
| 422 | `OFF_DUTY` | Location outside duty; drop points. |
| 422 | `BUSINESS_RULE` | `details.rule` (e.g. `PROMISE_DATE_RANGE`, `PROMISE_FOLLOW_UP_INVALID` (1.45.0, `details.reason`), `REASON_REQUIRED`, `LAST_SUPER_ADMIN`, `COWORK_INVALID_INVITEE`, `COWORK_TOO_MANY`, `TARGET_IN_PAST`, `PERMISSION_NOT_GRANTABLE` (1.48.0, `details.key`, `details.role`), `REQUEST_INVALID_TARGET` (1.48.0)). |
| 423 | `ACCOUNT_LOCKED` | `details.until`; since 1.47.0 also `details.retryAfterSec`, `details.scope` (`account` \| `ip`) and `Retry-After`. |
| 426 | `UPGRADE_REQUIRED` | `details.minVersion`, `details.storeUrl`. |
| 429 | `RATE_LIMITED` | Honour `Retry-After`. |
| 502/503 | `ERP_UNAVAILABLE` | Only on live ERP reads (`/refresh`); app keeps cached data. |
| 500 | `INTERNAL` | `requestId` shown in "copy error details". |

Conflict codes (inside collection `conflict.code`, not HTTP errors): `PLAN_SETTLED`, `AMOUNT_EXCEEDS_OUTSTANDING`, `PLAN_NOT_FOUND`, `CUSTOMER_INACTIVE`, `PERIOD_LOCKED`, `ERP_VALIDATION`, `NOT_IN_SCOPE_AT_RECORD_TIME`.

## 5. Type generation for consumers
- `admin-web`: `pnpm gen:api` runs `openapi-typescript ../field-api/docs/openapi.yaml -o src/shared/api/schema.d.ts` (or from a pinned release URL/commit) and uses `openapi-fetch`.
- `staff-app`: `make gen-api` runs `openapi-generator-cli generate -g dart-dio` into `packages/field_api_client/` (generated, not edited) **or** hand-written freezed models validated by contract tests against `openapi.yaml` examples (ADR-004).
- The contract version is `info.version` in openapi.yaml; consumers record the version they generated from in their CHANGELOG.
