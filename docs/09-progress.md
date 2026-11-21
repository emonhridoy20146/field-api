# 09 — Progress and Roadmap (system-wide, field-api view)

Status legend: ☐ not started · ◐ in progress · ☑ done. Update this file in every PR that changes status.
Order of work across repos for every phase: **field-api contract (openapi.yaml) → field-api implementation → admin-web & staff-app in parallel** (clients can start against a Prism mock of the contract on day one).

Estimates assume one AI-assisted developer per repo; they are planning aids, not commitments.

## Phase 0 — Foundations (≈ 2–3 weeks)
| Item | Repo | Status |
|---|---|---|
| Repos created with CLAUDE.md, README, docs, CI, lint boundaries | all | ◐ (field-api ✅) |
| core: config, db, logger, errors, events, outbox, jobs, idempotency, clock | A | ✅ |
| Module loader + manifest validation + feature gate + permission catalog | A | ✅ |
| auth, rbac, users, branches (ERP mirror), settings, flags, audit | A | ✅ |
| erp-gateway with MockErpClient + mock-erp server + fixtures from this spec | A | ✅ |
| Admin shell: layout, login, RBAC-aware nav, users & roles, permissions matrix, settings, flags, audit viewer | W | ☐ |
| App shell: theme, Bangla fonts, login, PIN unlock, local DB, sync engine skeleton, version gate | M | ☐ |
| Design tokens v1.0 implemented in both clients | W M | ☐ |
| Staging environment (Atlas M10, storage, API, admin hosting) | ops | ☐ |

**Acceptance:** SA logs into admin, creates a field staff, toggles a permission per user with reason, sees audit diff; staff logs into app (Bangla), sets PIN, app shows correct permissions after sync; disabling a module flag hides it in both clients; CI enforces boundaries (a deliberate cross-module import fails the build).

## Phase 1 — MVP field operations (≈ 6–8 weeks)
| Item | FRs | Status |
|---|---|---|
| ERP read sync (customers/plans/schedule/payments), status derivation, freshness | FR-ERP-001..005, FR-CUS-001..007, FR-CUS-010 | ✅ API |
| Customer list/detail/map (both clients) | FR-CUS-* | ✅ API |
| Assignments, areas, bulk assign | FR-ASG-* | ✅ API |
| Handovers incl. temporary cover | FR-HO-001..006 | ✅ API |
| Collections offline + idempotency + receipt blocks + ERP posting + conflicts | FR-COL-001..011, 013 | ✅ API |
| Cash on hand, limits, deposits, closing | FR-CASH-* | ✅ API |
| Visits + camera photos + media | FR-VIS-001..004, FR-MED-001 | ✅ API (thumbnails pending); storage driver `db` for hosts without S3 (1.18.0, ADR-039); attendance sent before its photo, photo linked after (1.21.0, ADR-040); live map keeps rough indoor points and shows the work-in spot before the first point (1.22.0, ADR-041) |
| Notes, promises, reminders, nightly evaluation | FR-NOTE-001, FR-PRM-001..003 | ✅ API |
| Tags + suggestion + review | FR-TAG-* | ✅ API |
| Attendance + shifts + holidays + corrections | FR-ATT-001..007, FR-SET-002/003 | ✅ API (FR-ATT-007 geofence not built; leave FR-ATT-008 built early) |
| Sync push/pull/bootstrap + sync center | FR-SYNC-* | ✅ API (bootstrap snapshots customers plus today's working state: attendance day, visits, co-work sessions, open promises, pending pin proposals; later changes arrive by pull) |
| Notifications (FCM + center) | FR-NOT-001..004 | ✅ API (push goes through a port; the real FCM sender needs credentials at deploy time; broadcasts FR-NOT-005 built early) |
| Inbox, dashboard, global search | FR-INB-001, FR-DSH-001, FR-SRCH-001 | ✅ API (inbox items for mock GPS / tracking stopped come with the location module; daily target is 0 until phase 3) |
| Pin corrections | FR-CUS-008 | ✅ API |
| Map pins: manager sets on the map, staff map pins, pinless customers applied at once (ADR-031, contract 1.11.0) | FR-CUS-011 | ✅ API |
| Pin colour by payment state, invoice filters and invoice viewer data (ADR-035, contract 1.14.0) | FR-CUS-012, FR-CUS-013 | ✅ API; screens in admin-web |
| Staff see every customer of their branches, staff in several branches, branch on list rows (ADR-038, contract 1.19.0) | FR-CUS-015 | ✅ API |
| Phones from before branch-wide visibility reload once (resync floor); health shows the contract (ADR-038 addendum, contract 1.20.1) | FR-CUS-015, FR-SYNC-001 | ✅ API |
| Leave cancel and filters, holiday delete and branch filter, my shift, who read a notice, offline notice read, guarantor calls (ADR-032, contract 1.12.0) | FR-ATT-008, FR-SET-002/003, FR-NOT-005, FR-M-014 | ✅ API |
| Duty hours per branch with break windows, overtime, late absences, validated default shift (ADR-044, contract 1.25.0) | FR-ATT-010..012 | ✅ API |
| Collection board: verified money, every branch, month and all time, any role (ADR-045, contract 1.26.0) | FR-REP-007 | ✅ API |
| Cash in hand, collection by collection (contract 1.27.0) | FR-CASH-007 | ✅ API |
| Paid this month / not paid this month filter on the customer list and map (contract 1.28.0) | FR-CUS-019 | ✅ API; admin-web filter follows |
| Which collections a deposit covered; the promise behind every cash line (contract 1.29.0) | FR-CASH-008 | ✅ API; admin-web deposit drawer follows |
| Extra phone numbers: add several at once, ERP / added marker, kept in FOS (ADR-042, contract 1.23.0) | FR-CUS-016 | ✅ API; screens in admin-web and staff-app follow |
| This month on a customer (visited, paid, pending, promises) and invoice counts per row and per list (contract 1.24.0) | FR-CUS-017, FR-CUS-018 | ✅ API; screens in admin-web and staff-app follow |
| Devices binding/remote logout | FR-AUTH-006..008 | ✅ API |
| Real ERP shape: plan = invoice, rolled lines, late fee, credit sales, ERP removals as reversed, warehouses, ERP employees picker, branch map point, real ERP posting rules (ADR-033, contract 1.13.0). Checked live against a sandbox copy of the ERP with the prototype API (1,441 customers, totals equal to the poisha) | FR-ERP-006, FR-BR-002 | ✅ API · ☐ ERP API installed in production (owner decision, erp-integration-spec v2 §8) |

**Acceptance (all must pass on staging with mock ERP, then with Laravel staging when available):**
1. J-1…J-8 and J-11, J-12 green (07-test-plan §5).
2. 50 collections recorded offline on a 2 GB Android 9 phone over a day sync with zero duplicates and zero loss; each shows `posted` or a visible conflict.
3. A conflict created by an office payment is visible to staff and manager within one sync cycle; resolution reaches the staff app.
4. Bad-customer suggestion matches a hand-calculated sample of 50 customers with varied plan lengths (3/5/6/12 months).
5. Cash position equals manual sum for 5 staff over 3 days.
6. Manager can run a full day (assign, handover, verify deposits, resolve conflicts) from a phone browser.
7. Pilot: 1 branch, 5 staff, 2 weeks, daily reconciliation report shows 0 unexplained mismatches.

## Phase 2 — Location (≈ 4–5 weeks)
| Item | FRs | Status |
|---|---|---|
| Spike: background location engine on 4 OEMs (Xiaomi, Samsung, Oppo/Realme, Vivo) | ADR-009 | ☐ |
| Duty-only adaptive tracking, filters, offline queue, heartbeat | FR-LOC-001..004, 010, 011 | ◐ server ✅ (ingest, duty check, filters, sampling config, heartbeat, tracking-stopped watchdog); app side in staff-app |
| Mock-location detection | FR-LOC-005 | ◐ server ✅ (flag stored, inbox once per staff and day); detection itself in staff-app |
| Latest-location map, route history, stops | FR-LOC-006..008 | ✅ API (with visit/collection overlay, stop ↔ visit link, today's totals on the marker); screens in admin-web |
| Visit suggestion from dwell | FR-VIS-005 | ☐ |
| Retention TTL + daily summaries | FR-LOC-009, 012 | ✅ |
| Co-work: requests, joint visits, manager view, single / co-work statistics with credit weight (added 2026-11-16) | FR-CW-001..005 | ✅ API (ADR-029); screens in staff-app and admin-web |
| Staff tasks: admin gives a task with a note, staff resolve request, admin verifies (added 2026-11-18) | FR-TASK-001..005 | ✅ API (contract 1.20.0, ADR-037, flag `module.tasks`); screens in admin-web and staff-app |

**Acceptance:** 9-hour duty day on a mid-range phone uses ≤ 12 % battery for tracking (bike + walking mix); no points outside duty; ≥ 90 % of 5-minute customer stops detected and matched; mock GPS app is flagged within one batch; route history renders a day in < 2 s on admin.

## Phase 3 — Reports (≈ 3 weeks)
| Item | FRs | Status |
|---|---|---|
| daily_metrics + overdue_snapshots jobs | FR-REP-001/002 | ◐ overdue snapshots ✅; daily_metrics not needed yet (ADR-028, reports aggregate live) |
| Staff performance (daily/monthly), branch trends, promise fulfilment | FR-REP-001/002, FR-PRM-004 | ✅ |
| Exports CSV/XLSX/PDF (Bangla) | FR-REP-003/004 | ✅ CSV + XLSX + PDF (async, 7 days, signed link, audited, bn/en headers; PDF shaped with HarfBuzz and embedded Noto fonts, ADR-030); data-quality export added |
| Reconciliation report, data-quality report, targets, leaderboard | FR-COL-014/015, FR-CUS-009, FR-REP-005 | ✅ API (contract 1.10.0, owner approval 2026-11-17): reconciliation; daily targets with branch defaults and history; target achievement in performance and dashboard; leaderboard (staff view behind a setting); own performance for the app; data-quality summary, items and export. Screens in admin-web and staff-app |

**Acceptance:** report numbers equal raw-query numbers for a sampled month; Bangla PDF renders conjuncts correctly; export of 10k rows < 60 s.

## Phase 4 — Premium & hardening (as approved)
SMS receipts (FR-COL-012), broadcasts (FR-NOT-005), leave (FR-ATT-008), staff-initiated handover (FR-HO-007), manager digest (FR-REP-006), offline map packs, Bluetooth printing, payment verification module, ASVS L2 review, performance tuning to 200 staff.

**2026-11-18 (contract 1.17.0):** delete a map pin (FR-CUS-014) and the "Sync from ERP" button (FR-ERP-007) are done in the API, ADR-036; admin-web screens follow in its own PR.

**Test hosting:** Vercel serverless test deployment ready (ADR-034, README "Test deployment on Vercel"); production host still OD-08.

**Go-live checklist (before any production branch):** ASVS L2 review done · restore drill passed · secrets rotated from staging · Atlas IP list = API egress only · privacy notice approved by counsel · staff trained (Bangla quick guide) · rollback plan (flags OFF) rehearsed.
