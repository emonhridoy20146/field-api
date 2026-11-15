# 04 — Architecture (field-api)

## 1. Stack

| Concern | Choice | Notes / ADR |
|---|---|---|
| Runtime | Node.js 22 LTS, TypeScript 5 (strict) | ADR-002 |
| HTTP | Fastify 5 + `fastify-type-provider-zod` | plugin encapsulation = module boundary (ADR-003) |
| Validation | zod (request/response); responses checked against `docs/openapi.yaml` in tests | ADR-004 |
| DB | MongoDB Atlas, Mongoose 8 | ADR-001 (fixed) |
| Jobs | Mongo-backed job runner (`@field/core/jobs`, Agenda-compatible interface) | ADR-008 |
| Object storage | S3-compatible (AWS S3 / Cloudflare R2 / DO Spaces / Wasabi), `@aws-sdk/client-s3` + presigner | ADR-010 |
| Push | Firebase Admin SDK (FCM HTTP v1) | — |
| Auth | JWT access (EdDSA/ES256, 15 min) + opaque rotating refresh tokens (hashed in DB) | ADR-006 |
| Passwords | argon2id | — |
| Logs | pino JSON, requestId correlation | NFR-OBS-001 |
| Tests | vitest, supertest/`fastify.inject`, mongodb-memory-server, nock / MSW for ERP, k6 load | 07-test-plan |
| Lint | eslint + typescript-eslint + dependency-cruiser (boundaries) + prettier | NFR-MNT-001 |
| Package manager | pnpm | — |
| Deploy | Docker image, 2 instances behind a load balancer (API) + 1 worker process (jobs) same image, `PROCESS_ROLE=api|worker` | ADR-011 |

## 2. Layering inside a module

```
routes (HTTP, zod schemas, permission guard)  →  service (use cases, transactions, events)
        →  repository (Mongoose models, queries)  →  Mongo
service may call other modules ONLY through their public index (`modules/<name>/index.ts`)
or by emitting/consuming events on the in-process EventBus (+ outbox for durable side effects).
domain/ holds pure functions (rules like overdue status, bad-suggestion, stop detection) — 100 % unit tested.
```

## 3. Module list

| Module | Flag key (default OFF) | Core? | Owns collections | Public API (index.ts) | Emits | Consumes | Phase |
|---|---|---|---|---|---|---|---|
| `core` | — | yes | `counters`, `jobs`, `outbox`, `idempotency_records`, `migrations_changelog` | config, db, logger, errors, EventBus, jobs, outbox, http helpers, `requirePermission`, `scope` | — | — | P0 |
| `auth` | — | yes | `sessions`, `login_attempts` | `verifyAccessToken`, `currentUser` | `auth.login`, `auth.login_failed`, `auth.session_revoked` | `user.deactivated` | P0 |
| `rbac` | — | yes | `permission_overrides` | `can(user,key)`, `effectivePermissions(user)`, `catalog()` | `rbac.changed` | module manifests | P0 |
| `users` | — | yes | `users` | `getUser`, `listStaff(branchId)` | `user.created`, `user.updated`, `user.deactivated` | — | P0 |
| `branches` | — | yes | `branches` | `getBranch`, `listBranches` | `branch.synced` | `erp.branches.synced` | P0 |
| `settings` | — | yes | `settings`, `holidays`, `shifts` | `getSetting<T>(key, branchId?)` | `settings.changed` | — | P0 |
| `flags` | — | yes | `feature_flags` | `isEnabled(key, branchId?)` | `flag.changed` | — | P0 |
| `audit` | — | yes | `audit_logs` | `audit.record(entry)` | — | `*.audited` events | P0 |
| `devices` | `module.devices` | no | `devices` | `getDevice`, `bind`, `isBound` | `device.bound`, `device.unbound` | `auth.login` | P1 |
| `erp-gateway` | — (always on, has `erp.mode` setting) | yes | `erp_sync_state` | `ErpClient` interface: `listChangedCustomers`, `getCustomer`, `postPayment`, `getPaymentByKey`, `listBranches` | `erp.customer.synced`, `erp.payment.posted`, `erp.payment.rejected`, `erp.payment.reversed` | `outbox:erp.post_payment` | P0 |
| `customers` | `module.customers` | no | `erp_customers`, `customer_overlays`, `location_proposals` | `getCustomer`, `scopeFilter(user)`, `customerStatus()` | `customer.balance_cleared`, `customer.location.approved` | `erp.customer.synced`, `assignment.changed` | P1 |
| `tags` | `module.tags` | no | `tag_events` (+ `customer_overlays.tag`) | `currentTag`, `suggestion` | `tag.changed`, `tag.review_needed` | `customer.balance_cleared` | P1 |
| `assignments` | `module.assignments` | no | `areas`, `assignments` | `assigneeOf(customerId)`, `customersOf(userId)`, `inScope(user, customerId)` | `assignment.changed` | `handover.accepted` | P1 |
| `handovers` | `module.handovers` | no | `handovers` | `pendingFor(userId)` | `handover.created`, `handover.accepted`, `handover.rejected`, `handover.expired` | `user.deactivated` | P1 |
| `collections` | `module.collections` | no | `collections`, `receipt_blocks` | `cashCollectedBy(userId)`, `listForCustomer` | `collection.received`, `collection.posted`, `collection.conflict`, `collection.resolved`, `collection.voided` | `erp.payment.*` | P1 |
| `cash` | `module.cash` | no | `cash_deposits`, `cash_closings` | `position(userId)` | `cash.limit_warning`, `cash.limit_exceeded`, `cash.deposit.recorded`, `cash.deposit.verified` | `collection.*` | P1 |
| `visits` | `module.visits` | no | `visits` | `lastVisit(customerId)` | `visit.recorded` | — | P1 |
| `notes` | `module.notes` | no | `notes` | `latestNotes(customerId, n)` | `note.created` | — | P1 |
| `promises` | `module.promises` | no | `promises` | `openPromise(customerId)` | `promise.created`, `promise.kept`, `promise.broken`, `promise.due` | `collection.posted`, `erp.customer.synced`, `handover.accepted` | P1 |
| `media` | — (used by others) | yes | `media` | `createUploadUrl`, `confirm`, `signedGetUrl` | `media.confirmed` | — | P1 |
| `attendance` | `module.attendance` | no | `attendance_days`, `attendance_events`, `leave_requests` | `isOnDuty(userId, at)`, `dayOf(userId,date)` | `attendance.work_in`, `attendance.work_out`, `attendance.auto_closed` | — | P1 |
| `sync` | `module.sync` | no | `sync_changes`, `device_sync_state` | — (HTTP only) | — | all `*.changed` domain events → change feed | P1 |
| `notifications` | `module.notifications` | no | `notifications`, `push_tokens`, `broadcasts` | `notify(userIds, type, payload)` | — | many | P1 |
| `inbox` **[ADDED]** | `module.inbox` | no | `inbox_items` | `raise(item)`, `resolve(key)` | `inbox.raised` | many | P1 |
| `dashboard` | `module.dashboard` | no | — (reads via public APIs + `daily_metrics`) | — | — | — | P1 |
| `search` **[ADDED]** | `module.search` | no | — (Atlas Search index or text index on `erp_customers`, `users`, `collections`) | — | — | — | P1 |
| `location` | `module.location` | no | `location_points` (time-series), `location_latest`, `location_heartbeats` | `latest(userId)` | `location.mock_detected`, `location.tracking_lost` | `attendance.*` | P2 |
| `stops` | `module.stops` | no | `location_stops`, `location_daily_summaries` | `stopsFor(userId,date)` | `stop.detected` | `location.batch_ingested` | P2 |
| `reports` | `module.reports` | no | `daily_metrics`, `overdue_snapshots`, `exports` | — | `export.ready` | nightly jobs | P3 |
| `sms` **[ADDED]** | `module.sms` | no | `sms_messages` | `send(to, templateKey, vars)` | — | `collection.received` | P4 |
| `microfinance` | `module.microfinance` (cannot enable, see FR-MF-001) | no | none (reserved prefix `mf_`) | none | none | none | reserved |

Future features land in `src/modules/<new-feature>/`. Examples already reserved by name: `payment-verify` (bKash/Nagad API verification), `printing` (server receipt PDF), `targets`, `complaints`, `microfinance`.

## 4. Module manifest

Every module exports a manifest from `src/modules/<name>/manifest.ts`. The app bootstrap (`src/app/register-modules.ts`) is the **only** place that lists modules.

```ts
// src/core/module/types.ts
export interface ModuleManifest {
  name: string;                       // kebab-case, equals folder name
  version: string;                    // semver of the module's API surface
  core?: boolean;                     // core modules cannot be flagged off
  featureFlag?: { key: `module.${string}`; default: false; description: string; owner: string; reviewBy?: string };
  dependsOn: string[];                // other module names (public index only)
  permissions: PermissionDef[];       // keys this module DECLARES (single definition)
  routes?: { prefix: string; plugin: FastifyPluginAsync };   // mounted under /api/v1
  events?: { emits: string[]; consumes: string[] };
  jobs?: JobDef[];                    // name, schedule (cron, Asia/Dhaka), handler
  migrations?: string;                // path to module migrations folder
  settings?: SettingDef[];            // typed setting keys with defaults (namespaced)
  syncEntities?: SyncEntityDef[];     // entities this module publishes to the mobile change feed
  inboxTypes?: InboxTypeDef[];
  notificationTypes?: NotificationTypeDef[];
}

export interface PermissionDef {
  key: string;                        // e.g. 'collection.record'
  description: { en: string; bn: string };
  defaults: Partial<Record<'super_admin'|'branch_manager'|'field_staff'|'viewer', boolean>>;
  reserved?: boolean;                 // microfinance.*
}
```

Example:

```ts
// src/modules/collections/manifest.ts
export const manifest: ModuleManifest = {
  name: 'collections',
  version: '1.0.0',
  featureFlag: { key: 'module.collections', default: false, description: 'Field collections', owner: 'field-api' },
  dependsOn: ['customers', 'assignments', 'erp-gateway', 'media', 'settings'],
  permissions: [
    { key: 'collection.record',  description: { en: 'Record a field collection', bn: 'মাঠে কিস্তি আদায় রেকর্ড' }, defaults: { super_admin: true, branch_manager: true, field_staff: true } },
    { key: 'collection.view',    description: { en: 'View collections', bn: 'আদায় দেখা' }, defaults: { super_admin: true, branch_manager: true, field_staff: true, viewer: true } },
    { key: 'collection.void',    description: { en: 'Void unposted collection', bn: 'পোস্ট না হওয়া আদায় বাতিল' }, defaults: { super_admin: true, branch_manager: true } },
    { key: 'collection.resolve', description: { en: 'Resolve collection conflicts', bn: 'আদায়ের দ্বন্দ্ব নিষ্পত্তি' }, defaults: { super_admin: true, branch_manager: true } },
  ],
  routes: { prefix: '/collections', plugin: collectionsRoutes },
  events: { emits: ['collection.received','collection.posted','collection.conflict','collection.resolved','collection.voided'],
            consumes: ['erp.payment.posted','erp.payment.rejected','erp.payment.reversed'] },
  jobs: [{ name: 'collections.retry-stuck-posting', schedule: '*/10 * * * *', handler: retryStuck }],
  migrations: './migrations',
  settings: [{ key: 'collections.photoRequiredAbovePoisha', type: 'int', default: 0 }],
  syncEntities: [{ entity: 'collection', scope: 'own' }],
  inboxTypes: [{ type: 'collection.conflict', severity: 'high' }, { type: 'collection.posting_failed', severity: 'critical' }],
};
```

Boot sequence: load manifests → validate (unique names, unique permission keys, dependsOn exist and are acyclic, flags have default false) → register permissions in catalog → run migrations → mount routes (wrapped by `featureGate(flagKey)`) → subscribe events → register jobs (worker only).

### Boundary rules (enforced by `.dependency-cruiser.cjs`)
1. `src/modules/A/**` may import `src/modules/B/index.ts` only, and only if `B ∈ A.manifest.dependsOn`.
2. Modules may import `src/core/**` and `src/shared/**`. `core` imports no module.
3. No module imports another module's `models/` — data access only through public functions.
4. Cross-module **writes** happen through events (in-process) or the outbox (durable), never by updating another module's collection.
5. `src/app/**` is the only place that imports every manifest.

### Adding a new module (checklist — also in CLAUDE.md)
1. Create `src/modules/<name>/` from `templates/module/`.
2. Fill manifest: flag (default false), permissions (check catalog for duplicates), events, jobs, settings.
3. Add routes to `docs/openapi.yaml` **first** (design-first), then implement.
4. Add requirements to `docs/02-requirements.md` with new FR-IDs (`proposed`).
5. Add collections/indexes to `docs/06-data-model.md` and a migration.
6. Register in `src/app/register-modules.ts`.
7. Tests: domain unit, route integration, OpenAPI conformance; contract test if ERP involved.
8. Update `docs/09-progress.md`, `docs/CHANGELOG.md`, and an ADR if a decision was made.

## 5. Folder tree

```
field-api/
├── CLAUDE.md
├── README.md
├── package.json · pnpm-lock.yaml · tsconfig.json · vitest.config.ts
├── .env.example
├── .dependency-cruiser.cjs
├── .eslintrc.cjs · .prettierrc
├── Dockerfile · docker-compose.yml          # mongo + minio + mock-erp for local dev
├── docs/
│   ├── 01-system-analysis.md … 09-progress.md
│   ├── openapi.yaml                          # API contract (source of truth)
│   ├── erp-integration-spec.md
│   ├── runbooks/                             # backup-restore.md, incident.md, rotate-secrets.md
│   └── CHANGELOG.md
├── scripts/
│   ├── gen-types.ts                          # openapi → src/generated/api.d.ts
│   ├── check-permissions.ts                  # unique keys, used ⊆ declared
│   ├── seed-dev.ts · seed-profile-prod-p1.ts # flags ON for released modules
│   └── restore-drill.sh
├── templates/module/                         # scaffold for a new module
├── test/
│   ├── fixtures/erp/                         # recorded Laravel responses (JSON) per endpoint/version
│   ├── contract/                             # ERP fixtures + OpenAPI conformance
│   ├── helpers/                              # app factory, auth helper, clock mock
│   └── load/                                 # k6 scripts
├── mock-erp/                                 # tiny Fastify server serving fixtures (local + CI)
└── src/
    ├── main.ts                               # starts api or worker by PROCESS_ROLE
    ├── app/
    │   ├── build-app.ts                      # Fastify instance, plugins, error handler
    │   ├── register-modules.ts               # the ONLY list of manifests
    │   └── worker.ts                         # job runner + outbox dispatcher
    ├── core/
    │   ├── config/                           # env schema (zod), typed config
    │   ├── db/                               # mongoose connection, transactions helper, migrations runner
    │   ├── errors/                           # AppError, error codes, problem+json mapper
    │   ├── events/                           # EventBus (typed), outbox
    │   ├── jobs/                             # JobScheduler interface + mongo impl (leases)
    │   ├── http/                             # pagination (cursor), requestId, rate limit, gzip, version gate
    │   ├── security/                         # requirePermission, scope helpers, jwt keys
    │   ├── time/                             # Dhaka clock, date utils (Luxon), injectable clock
    │   ├── money/                            # poisha helpers, BDT formatting
    │   ├── geo/                              # haversine, bbox, BD bounds, polyline simplify
    │   ├── idempotency/                      # store + middleware
    │   ├── module/                           # ModuleManifest types, loader, validator
    │   └── logger/
    ├── shared/                               # pure types/utilities with no I/O
    ├── generated/api.d.ts                    # from openapi (do not edit)
    └── modules/
        ├── auth/            ├── rbac/          ├── users/          ├── branches/
        ├── settings/        ├── flags/         ├── audit/          ├── devices/
        ├── erp-gateway/     ├── customers/     ├── tags/           ├── assignments/
        ├── handovers/       ├── collections/   ├── cash/           ├── visits/
        ├── notes/           ├── promises/      ├── media/          ├── attendance/
        ├── sync/            ├── notifications/ ├── inbox/          ├── dashboard/
        ├── search/          ├── location/      ├── stops/          ├── reports/
        ├── sms/             └── microfinance/  # README.md + manifest only (reserved)
        └── <every module>/
            ├── manifest.ts
            ├── index.ts                      # public API (the only importable file)
            ├── routes.ts                     # Fastify plugin
            ├── schemas.ts                    # zod request/response
            ├── service.ts                    # use cases
            ├── repository.ts
            ├── models/*.model.ts             # mongoose schemas (private)
            ├── domain/*.ts                   # pure rules
            ├── events.ts                     # typed event payloads + handlers
            ├── jobs.ts
            ├── migrations/NNNN-*.ts
            └── __tests__/                    # unit + integration
```

`erp-gateway` internal layout:
```
erp-gateway/
├── client/ErpClient.ts              # interface
├── client/LaravelErpClient.ts       # HTTP impl (undici), retries, circuit breaker
├── client/MockErpClient.ts          # in-memory, for tests
├── mappers/                         # Laravel JSON → internal types (ONLY place that knows Laravel field names)
├── sync/delta-sync.job.ts · nightly-reconcile.job.ts
└── outbox/post-payment.handler.ts
```
**Rule:** Laravel field names appear **only** in `erp-gateway/mappers/` and `test/fixtures/erp/`. When the maintainer confirms the real schema, only mappers and fixtures change.

## 6. Cross-cutting design

### 6.1 Errors (RFC 9457 problem+json)
```json
{ "type": "https://errors.howlader.app/collection/idempotency-mismatch",
  "title": "Idempotency key reused with different payload",
  "status": 409, "code": "IDEMPOTENCY_MISMATCH", "requestId": "01JC…", "details": { "idempotencyKey": "0193…" } }
```
Error code list lives in `docs/05-api-contract.md §4`.

### 6.2 Scope enforcement
`scope.customerFilter(user)` returns a Mongo filter: SA → `{}`; BM/VW → `{ branchId: { $in: user.branchIds } }`; FS → `{ _id: { $in: assignments.customersOf(user.id) } }` (materialized in `assignments` as `customerIds` per user to keep it one query). Every repository method that lists customer-linked data takes a scope argument; integration tests assert cross-branch access returns 404 (not 403, to avoid leaking existence).

### 6.3 Time
All timestamps stored as UTC `Date`. Business dates stored as `YYYY-MM-DD` strings in Dhaka time (`businessDate`). Clock is injectable for tests.

### 6.4 Transactions
Multi-document writes that must be atomic (collection + receipt sequence + outbox entry; handover acceptance + assignment changes) use Mongo transactions (Atlas replica set).

### 6.5 Outbox
`outbox` documents `{ _id, type, payload, status: pending|processing|done|failed, attempts, nextAttemptAt, lastError, lockedUntil }`. Written in the same transaction as the business change; dispatched by worker every 5 s; exponential backoff (30 s, 2 m, 10 m, 1 h, then hourly up to 24 h).

## 7. Key flows

### 7.1 Offline collection sync and ERP posting
```
staff-app                      field-api (api)                       worker                 Laravel
   │ save locally (queued)          │                                   │                       │
   │ idempotencyKey = UUIDv7        │                                   │                       │
   │── POST /sync/push ────────────►│ auth, flag, permission            │                       │
   │   [{mutationId, entity:        │ idempotency lookup (key)          │                       │
   │     collection, op:create,…}]  │  ├─ found & same hash → replayed  │                       │
   │                                │  ├─ found & diff hash → 409       │                       │
   │                                │  └─ new: TX { insert collection   │                       │
   │                                │        status=received, flags;    │                       │
   │                                │        outbox erp.post_payment;   │                       │
   │                                │        change-feed entry }        │                       │
   │◄── 200 results[applied, id] ───│ emit collection.received          │                       │
   │ mark synced                    │  → cash.position update           │                       │
   │                                │  → sms (proposed)                 │                       │
   │                                │                                   │── POST /payments ────►│
   │                                │                                   │  Idempotency-Key      │
   │                                │                                   │◄─ 201 posted ─────────│
   │                                │    status=posted, erpPaymentId,   │  or 200 replay        │
   │                                │    erpReceiptNo; refresh customer │  or 409/422 business  │
   │                                │                                   │   → status=conflict,  │
   │                                │                                   │     inbox + push      │
   │                                │                                   │  or 5xx/timeout       │
   │                                │                                   │   → retry (outbox)    │
   │── GET /sync/pull ─────────────►│ change feed: collection status    │                       │
   │◄── posted / conflict ──────────│                                   │                       │
```
Timeout ambiguity: if Laravel times out, the worker first calls `GET /payments/by-idempotency-key/{key}` before retrying, so a payment that was actually stored is not posted twice even if Laravel's own idempotency failed.

### 7.2 Conflict resolution
`conflict` codes: `PLAN_SETTLED`, `AMOUNT_EXCEEDS_OUTSTANDING`, `PLAN_NOT_FOUND`, `CUSTOMER_INACTIVE`, `PERIOD_LOCKED`, `ERP_VALIDATION`, `NOT_IN_SCOPE_AT_RECORD_TIME` (staff was no longer assignee — still accepted, flagged).
Manager actions (`POST /collections/{id}/resolve`): `post_to_plan {planId}` · `post_as_advance` (if ERP supports, E-20) · `refund {proofMediaId}` · `void {reason}`. Each re-enters the outbox or closes the record; staff notified.

### 7.3 Handover
```
manager: POST /handovers {fromUserId,toUserId,areaIds,customerIds,reason,effectiveDate,endDate?}
  → validate scope, from-staff holds them, to-staff active & same branch (or cross-branch with SA)
  → status pending_acceptance; push to receiver; inbox item if not accepted in 24 h; expires 72 h
receiver: POST /handovers/{id}/accept
  → TX: end old assignments (effectiveTo=now), create new (effectiveFrom=now, source=handover:{id}),
        move open promises' ownerId, emit assignment.changed → change feed for both devices
  → from-staff device receives tombstones; their unsynced local data for those customers still syncs
    (server accepts with flag NOT_IN_SCOPE_AT_RECORD_TIME only if recorded after acceptance)
  → if from-staff has cash on hand: warning to manager (cash not transferred)
endDate set → job reverts on endDate (temporary cover)
```

### 7.4 Bad-customer suggestion and tag review
```
erp delta sync → erp.customer.synced {customerId, plans[]}
customers: compute status (overdue, daysOverdue, finalDueDate, outstanding, badSuggested)
   badSuggested = plans.some(p => p.finalDueDate < todayDhaka && p.outstandingPoisha > 0)
   if previous totalOutstanding > 0 and now == 0 → emit customer.balance_cleared
tags: on customer.balance_cleared, if tag active → notify tag.approve holders + inbox 'tag.review_needed'
```

### 7.5 Location ingest
```
app batches ≤500 points → POST /location/points (gzip)
 → verify on-duty window per point (attendance.isOnDuty) else drop with reason OFF_DUTY
 → filter accuracy > 50 m, speed > 120 km/h, future timestamps, duplicates (userId+recordedAt)
 → insertMany into time-series `location_points` (ordered:false)
 → upsert `location_latest`
 → emit location.batch_ingested → stops job (incremental per user, every 5 min) 
```

### 7.6 ERP delta sync
Every 5 min per branch: `GET changes since cursor` → upsert `erp_customers` (with `erpFetchedAt`, `erpVersion`) → recompute status → change-feed entries for affected assignees → store cursor. Nightly 02:00 Dhaka: full reconcile per branch (paged) to catch missed deltas; mark customers missing from ERP as `erpStatus=missing` (never delete).

## 8. Environments
`local` (docker-compose: mongo replica set, minio, mock-erp) · `staging` (Atlas M10, Laravel staging or mock-erp) · `production` (Atlas M10→M20, region close to Bangladesh, see OD-08). Same image, config via env.
