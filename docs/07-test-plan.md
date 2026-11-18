# 07 — Test Plan (field-api, and system-level)

## 1. Test pyramid and tools

| Level | Tool | Scope | Gate |
|---|---|---|---|
| Unit (U) | vitest | `domain/` pure rules, mappers, utils | 90 % line coverage on `domain/` and `erp-gateway/mappers/`; 80 % overall |
| Integration (I) | vitest + `fastify.inject` + mongodb-memory-server (replica set mode for transactions) | route → service → Mongo, permissions, scope, events, outbox | every route: happy path, 401, 403, out-of-scope 404, validation 400 |
| Contract (C) | vitest + recorded fixtures in `test/fixtures/erp/` + `mock-erp/`; OpenAPI conformance via ajv against `docs/openapi.yaml` | ERP mapping; every response body validated against OpenAPI | 100 % of endpoints in openapi.yaml have a conformance test |
| E2E (E) | Playwright (admin-web repo) + Flutter integration_test/Patrol (staff-app repo) against staging stack with mock-erp | cross-repo user journeys | journeys J-1…J-12 green before release |
| Load | k6 | sync push, location ingest, customer list | NFR-PERF-001 thresholds |
| Security | gitleaks, `pnpm audit`, OWASP ZAP baseline on staging, manual ASVS L2 checklist | — | no high findings |
| Manual device (D) | checklist in staff-app/docs/07-test-plan.md | real low-end phones | signed off per release |
| Restore drill | `scripts/restore-drill.sh` | backup → staging restore | monthly, logged |

## 2. Critical unit test cases (domain)

| Rule | Cases |
|---|---|
| `badSuggested` (FR-TAG-001) | final due yesterday + outstanding 1 poisha → true; final due today → false (strictly passed); outstanding 0 → false; two plans one qualifies → true; no `end_date` → uses max schedule date; 3/5/6/12/18-month plans all pass without month logic; timezone: 2026-11-14T18:30Z is 15 Nov in Dhaka |
| overdue / dueToday | line due today unpaid → dueToday; partial payment; estimated allocation flag |
| Promise evaluation | kept exactly; overpaid; partial; payment one day after with grace 1 → kept; superseded |
| Cash position | cash only; voided excluded; refunded excluded; pending deposit reduces; rejected deposit restores |
| Attendance | late by grace boundary (exactly 15 min → not late); break overlap; auto-close; holiday; weekly off Friday |
| Stop detection | 5 min at 59 m radius → stop; jitter at 70 m; gap in data splits stop; matches nearest pin |
| Location filters | accuracy 50.1 m dropped; 121 km/h implied speed dropped; future 3 min dropped |
| RBAC evaluation | user deny beats branch allow; branch deny wins across multiple branches; SA allow; reserved key never granted; last SA guard |
| Receipt numbers | block allocation, no overlap across devices, date rollover at Dhaka midnight |
| Idempotency | same key same hash → replay; same key different hash → mismatch; normalized hash ignores note |
| Coordinates validation | null, 0/0, swapped (lat 90.37, lng 22.71), outside BD bbox |

## 3. Integration test scenarios (must exist)
1. Collection pushed twice via `/sync/push` and once via `/collections` with same key → exactly one document, one outbox entry.
2. ERP returns `PLAN_SETTLED` → status conflict, inbox item, notification to collector + BM, visible in `/collections/conflicts`.
3. ERP times out, payment actually stored → worker calls lookup-by-key → status posted, no second POST.
4. Circuit open → outbox pauses; app sync still succeeds; `/system/erp-status` shows `open`.
5. Handover accept transaction: assignments switched, promises moved, change-feed entries for both users; reject leaves state unchanged; expiry job.
6. Staff of branch A requests customer of branch B → 404.
7. Flag OFF → `403 FEATURE_DISABLED`; flag ON for branch A only → branch B users get 403.
8. Permission override removes `tag.set` for one staff → `PUT /customers/{id}/tag` 403; pull includes new permission set; audit entry exists with reason.
9. Balance cleared in ERP sync for tagged customer → `tag.review_needed` inbox + notification.
10. Location points outside duty → rejected `OFF_DUTY`; mock point stored with flag + one inbox item/day.
11. Sync pull with expired cursor → 410; bootstrap returns full scope.
12. Audit log: API Mongo user cannot update/delete (tested with restricted role in CI using a real mongod).
13. Migrations: fresh DB and re-run (idempotent).

## 4. Contract tests (Laravel)
For every endpoint in erp-integration-spec v2 §4: fixture cases `ok`, `empty`, `nulls` (coords null, end_date null, schedule.paid null), `money-as-string`, `money-as-int`, `offset-pagination`, `error-*` per §6. When the maintainer delivers staging, fixtures are re-recorded and the suite must still pass with only mapper changes.

## 5. Cross-repo E2E journeys

| ID | Journey | Repos |
|---|---|---|
| J-1 | SA creates staff, assigns area; staff logs in on device, sees customers | W M A |
| J-2 | Staff collects offline (airplane mode), 3 collections, reconnects; ERP mock posts; manager sees posted | M A W |
| J-3 | Conflict: office pays same plan in ERP mock first; field collection becomes conflict; manager resolves post_to_plan; staff sees resolution | M A W |
| J-4 | Cash limit: staff exceeds 80 % → warning; deposit with slip; manager verifies; on-hand drops | M A W |
| J-5 | Handover: manager creates; receiver accepts in app; old staff loses customers; notes visible to new | W M A |
| J-6 | Visit with camera photo + promise for tomorrow; next day reminder fires at 09:00 (clock override) | M A |
| J-7 | Tag: staff tags with reason; SA removes `tag.set` for that staff; staff UI hides tag action after sync | M W A |
| J-8 | Attendance day: work-in late, break 50 min, work-out; summary shows late and break | M A W |
| J-9 | Tracking: simulated route (mock provider in test build only) → history shows stops at two customers; visit suggestion appears | M A W |
| J-10 | Reports: monthly staff performance export XLSX in Bangla opens correctly | W A |
| J-11 | Version gate: min version raised → app shows update screen; queued data is not lost | A M |
| J-12 | Permission audit: every change in J-7 appears in audit viewer with diff | W A |

## 6. Non-functional tests
- **Load (k6, staging, 200 virtual staff):** sync push 50 mutations p95 < 2 s; location ingest 500 points p95 < 800 ms; customer list p95 < 300 ms; error rate < 0.5 %.
- **Soak:** 8 h simulated duty day for 100 staff; no memory growth > 10 %; outbox drained.
- **Chaos:** kill worker mid-posting → no duplicates after restart; Mongo primary step-down during sync → retries succeed.
- **Security:** JWT tampering, refresh reuse, IDOR on every `{id}` route (automated scope tests), rate limits, upload content-type spoofing, presigned URL expiry.
- **Backup:** monthly restore drill with verification script (counts, audit hash chain).

## 7. CI pipeline
`lint (eslint, depcruise, prettier)` → `typecheck` → `check-permissions` → `openapi lint (redocly)` → `unit` → `integration` → `contract` → `build image` → `gitleaks` → `docs check (CHANGELOG touched if src changed)`. Nightly: load smoke, ZAP baseline, dependency audit.

## 8. Traceability matrix (FR → module → test types)
Generated from 02-requirements.md (Module = owning field-api module; Test = required test types; `D`/`E` executed in client repos).

| FR | Module | Status | Phase | Repos | Tests |
|---|---|---|---|---|---|
| FR-AUTH-001 | auth (+devices for 007) | active | P0 | A W M | U I E |
| FR-AUTH-002 | auth (+devices for 007) | active | P0 | A W M | U I |
| FR-AUTH-003 | auth (+devices for 007) | active | P0 | A W M | U I E |
| FR-AUTH-004 | auth (+devices for 007) | active | P0 | A W | I E |
| FR-AUTH-005 | auth (+devices for 007) | active | P0 | A | I |
| FR-AUTH-006 | auth (+devices for 007) | proposed [ADDED] | P1 | M | U D |
| FR-AUTH-007 | devices | proposed [ADDED] | P1 | A W M | I E |
| FR-AUTH-008 | auth + devices | proposed [ADDED] | P1 | A W M | I E |
| FR-AUTH-009 | auth (+devices for 007) | proposed [ADDED] | P0 | A M | I D |
| FR-AUTH-010 | auth (+devices for 007) | active | P1 | M A | U D |
| FR-RBAC-001 | rbac | active | P0 | A W | U I |
| FR-RBAC-002 | rbac | active | P0 | A W | I C |
| FR-RBAC-003 | rbac | active | P0 | A W | I E |
| FR-RBAC-004 | rbac | active | P0 | A W | I E |
| FR-RBAC-005 | rbac | active | P0 | A W | I |
| FR-RBAC-006 | rbac | active | P1 | A M | I D |
| FR-RBAC-007 | rbac | active | P0 | A | U I |
| FR-USER-001 | users | active | P0 | A W | I E |
| FR-USER-002 | users | active | P0 | A W | I |
| FR-BR-001 | branches | active | P0 | A W | C I |
| FR-SET-001 | settings | active | P0 | A W | U I |
| FR-FLAG-001 | flags | active | P0 | A W | U I |
| FR-FLAG-002 | flags | active | P0 | A W M | I E |
| FR-SET-002 | settings | proposed [ADDED] | P1 | A W | I |
| FR-SET-003 | settings | proposed [ADDED] | P1 | A W | I |
| FR-ERP-001 | erp-gateway | active | P0 | A | U C |
| FR-ERP-002 | erp-gateway | active | P1 | A | C I |
| FR-ERP-003 | erp-gateway | active | P1 | A W M | C I |
| FR-ERP-004 | erp-gateway | active | P1 | A W | I E |
| FR-ERP-005 | erp-gateway | active | P1 | A W | I E |
| FR-CUS-001 | customers | active | P1 | A W M | I E |
| FR-CUS-002 | customers | active | P1 | A W M | I E |
| FR-CUS-003 | customers | active | P1 | A W M | I E |
| FR-CUS-004 | customers | active | P1 | A W M | U C |
| FR-CUS-005 | customers | active | P1 | A W M | I E |
| FR-CUS-006 | customers | active | P1 | W M | E D |
| FR-CUS-007 | customers | active | P1 | A W M | I E |
| FR-CUS-008 | customers + media | proposed [ADDED] | P1 | A W M | I E D |
| FR-CUS-009 | reports + customers | proposed [ADDED] | P3 | A W | I |
| FR-CUS-010 | customers | proposed [ADDED] | P1 | A W M | U D |
| FR-TAG-001 | tags | active | P1 | A | U C |
| FR-TAG-002 | tags | active | P1 | A W M | U E |
| FR-TAG-003 | tags | active | P1 | A W M | I E |
| FR-TAG-004 | tags | active | P1 | A | I |
| FR-TAG-005 | tags | active | P1 | A W | I |
| FR-TAG-006 | tags | active | P1 | A W M | I E |
| FR-TAG-007 | tags | active | P1 | A W M | I E |
| FR-TAG-008 | tags | proposed [ADDED] | P1 | A W M | U I |
| FR-COL-001 | collections | active | P1 | A M | U I E D |
| FR-COL-002 | collections | active | P1 | A M | U I |
| FR-COL-003 | collections | active | P1 | M | U D |
| FR-COL-004 | collections | active | P1 | A M | U I C |
| FR-COL-005 | collections | active | P1 | A W M | U I |
| FR-COL-006 | collections | active | P1 | A W M | I E |
| FR-COL-007 | collections | active | P1 | A W M | I E |
| FR-COL-008 | collections | active | P1 | A | I C |
| FR-COL-009 | collections | active | P1 | A W | I C |
| FR-COL-010 | collections | active | P1 | A W | I E |
| FR-COL-011 | collections | proposed [ADDED] | P1 | A M | U D |
| FR-COL-012 | sms | proposed [ADDED] | P4 | A | I |
| FR-COL-013 | collections | proposed [ADDED] | P1 | A W | U I |
| FR-COL-014 | reports | proposed [ADDED] | P3 | A W | I C |
| FR-COL-015 | reports | proposed [ADDED] | P3 | A W M | I |
| FR-CASH-001 | cash | active | P1 | A M W | U I |
| FR-CASH-002 | cash | active | P1 | A M W | U I D |
| FR-CASH-003 | cash | active | P1 | A M W | I E |
| FR-CASH-004 | cash | active | P1 | A W | I E |
| FR-CASH-005 | cash | active | P1 | A W | I E |
| FR-CASH-006 | cash | proposed [ADDED] | P1 | A M | U D |
| FR-ASG-001 | assignments | active | P1 | A W | I E |
| FR-ASG-002 | assignments | active | P1 | A W | U I E |
| FR-ASG-003 | assignments | active | P1 | W A | E |
| FR-ASG-004 | assignments | active | P1 | A W | I |
| FR-ASG-005 | assignments | active | P1 | A W | I |
| FR-HO-001 | handovers | active | P1 | A W M | U I E |
| FR-HO-002 | handovers | active | P1 | A M | I D |
| FR-HO-003 | handovers | active | P1 | A W M | I E |
| FR-HO-004 | handovers | active | P1 | A M | I D |
| FR-HO-005 | handovers | active | P1 | A M | U |
| FR-HO-006 | handovers | proposed [ADDED] | P1 | A W | U I |
| FR-HO-007 | handovers | proposed [ADDED] | P4 | A W M | I |
| FR-VIS-001 | visits | active | P1 | A M | U I D |
| FR-VIS-002 | visits | active | P1 | M | U D |
| FR-VIS-003 | visits | active | P1 | A M | I D |
| FR-VIS-004 | visits | active | P1 | A M W | U |
| FR-VIS-005 | stops (server) / visits | active | P2 | M A | U D |
| FR-NOTE-001 | notes + media | active | P1 | A W M | I E |
| FR-PRM-001 | promises | active | P1 | A W M | U I E |
| FR-PRM-002 | promises | active | P1 | A M | I D |
| FR-PRM-003 | promises | active | P1 | A | U I |
| FR-PRM-004 | reports | active | P3 | A W | U I |
| FR-MED-001 | media | active | P1 | A | I |
| FR-ATT-001 | attendance | active | P1 | A M | U I D |
| FR-ATT-002 | attendance | active | P1 | A M | U I |
| FR-ATT-003 | attendance | active | P1 | A | U |
| FR-ATT-004 | attendance | active | P1 | A W | U I E |
| FR-ATT-005 | attendance | active | P1 | A M | U I |
| FR-ATT-006 | attendance | active | P1 | A W | I E |
| FR-ATT-007 | attendance | proposed [ADDED] | P1 | A M | U |
| FR-ATT-008 | attendance | proposed [ADDED] | P4 | A W M | I E |
| FR-LOC-001 | location / stops | active | P2 | A M | U I D |
| FR-LOC-002 | location / stops | active | P2 | M | U D |
| FR-LOC-003 | location / stops | active | P2 | A M | U |
| FR-LOC-004 | location / stops | active | P2 | M A | U I D |
| FR-LOC-005 | location / stops | active | P2 | M A | D I |
| FR-LOC-006 | location / stops | active | P2 | A W | I E |
| FR-LOC-007 | location + stops | active | P2 | A W | I E |
| FR-LOC-008 | stops | active | P2 | A | U I |
| FR-LOC-009 | location / stops | active | P2 | A | I |
| FR-LOC-010 | location / stops | active | P2 | A M | I D |
| FR-LOC-011 | location / stops | active | P2 | M A | D |
| FR-LOC-012 | stops | proposed [ADDED] | P3 | A W | U I |
| FR-NOT-001 | notifications | active | P1 | A M | I D |
| FR-NOT-002 | notifications | active | P1 | A M W | I D |
| FR-NOT-003 | notifications | active | P1 | A M W | I E |
| FR-NOT-004 | notifications | active | P1 | A | U |
| FR-NOT-005 | notifications | proposed [ADDED] | P4 | A W M | I E |
| FR-INB-001 | inbox | proposed [ADDED] | P1 | A W | I E |
| FR-DSH-001 | dashboard | active | P1 | A W | I E |
| FR-SRCH-001 | search | proposed [ADDED] | P1 | A W | I E |
| FR-REP-001 | reports | active | P3 | A W | U I E |
| FR-REP-002 | reports | active | P3 | A W | U I |
| FR-REP-003 | reports | active | P3 | A W | E D |
| FR-REP-004 | reports | active | P3 | A W | I E |
| FR-REP-005 | reports | proposed [ADDED] | P3 | A M W | I |
| FR-REP-006 | reports + notifications | proposed [ADDED] | P4 | A | I |
| FR-AUD-001 | audit | active | P0 | A | U I |
| FR-AUD-002 | audit | active | P0 | A | U |
| FR-AUD-003 | audit | active | P1 | A W | E |
| FR-AUD-004 | audit | active | P0 | A | I |
| FR-SYNC-001 | sync | active | P1 | A M | I C |
| FR-SYNC-002 | sync | active | P1 | A M | U I |
| FR-SYNC-003 | sync | active | P1 | M | U |
| FR-SYNC-004 | sync | active | P1 | A M | U |
| FR-SYNC-005 | sync | active | P1 | M W A | D E |
| FR-SYNC-006 | sync | active | P1 | A M | D |
| FR-MF-001 | microfinance | active | P0 | A W M | U |
| FR-MF-002 | microfinance | active | P0 | A | — |

Total FRs: 138. Without automated test type: FR-MF-002 (FR-MF-002 is a documentation rule, verified in review).
