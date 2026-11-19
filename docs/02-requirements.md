# 02 — Requirements (master catalog)

> This file is the **master catalog** for the whole system. Every FR-ID is defined here once.
> `admin-web/docs/02-requirements.md` and `staff-app/docs/02-requirements.md` list the subset each client implements, using the **same IDs**, plus client-only UI requirements.
> The **permission catalog (§3)** is the single definition of every permission key.

## 1. Conventions

- **ID format:** `FR-<AREA>-<NNN>` for functional, `NFR-<AREA>-<NNN>` for non-functional. IDs are never reused; dropped items stay with status `dropped`.
- **Status:** `proposed` (not yet approved by client) · `active` (approved, to be built) · `done` · `dropped`.
  - Everything from the client brief is `active`.
  - Everything this spec added is `proposed` and marked **[ADDED]**. The client approves or drops them; nothing else in the spec breaks if one is dropped, because each lives in its own module or behind its own flag.
- **Phase:** P0 foundation · P1 MVP · P2 location · P3 reports · P4 premium/hardening (see 09-progress).
- **Repos:** `A` field-api · `W` admin-web · `M` staff-app (mobile).
- **Module:** the field-api module that owns the rule (see 04-architecture §3).
- **Test:** U unit · I integration (API + Mongo) · C contract (Laravel fixtures / OpenAPI) · E e2e · D manual device checklist.
- **Time:** every date rule is evaluated in **Asia/Dhaka**. "Today" = the Dhaka calendar date.
- **Money:** integer **poisha** (1 BDT = 100 poisha) in storage and API (`amountPoisha`). Display in BDT with `৳` and Bangla or Latin digits per user setting.

## 2. Roles

| Role key | Description | Scope |
|---|---|---|
| `super_admin` | Owner / head office | All branches. Implicitly holds every permission except reserved namespaces (`microfinance.*`) until the microfinance flag and legal sign-off exist. Cannot be locked out: at least one active super admin must always exist. |
| `branch_manager` | Manages one or more branches | `user.branchIds[]` |
| `field_staff` | Collects and visits | Every customer of their branches (one or more) since 1.19.0 (FR-CUS-015); only the ones assigned to them where a branch sets `customers.staffVisibility = assigned` |
| `viewer` **[ADDED]** | Read-only (e.g. accounts, auditor) | `user.branchIds[]` or all |

A user has exactly **one role** and one or more `branchIds`. Effective permissions are computed as described in §3.3.

## 3. Permission catalog (single source of truth)

### 3.1 Keys

Defaults: SA = super_admin, BM = branch_manager, FS = field_staff, VW = viewer. ● = granted by default, ○ = not granted by default (toggleable).

| Key | Meaning | SA | BM | FS | VW | Module |
|---|---|---|---|---|---|---|
| `user.view` | List/view users in scope | ● | ● | ○ | ● | users |
| `user.manage` | Create/edit/deactivate users, reset password, in scope (BM cannot create SA/BM) | ● | ○ | ○ | ○ | users |
| `rbac.view` | View roles, overrides, effective permissions | ● | ● | ○ | ○ | rbac |
| `rbac.manage` | Change branch/user permission overrides | ● | ○ | ○ | ○ | rbac |
| `branch.view` | View branches | ● | ● | ● | ● | branches |
| `settings.manage` | Org settings, duty hours, thresholds, holidays | ● | ○ | ○ | ○ | settings |
| `erp.sync` | "Sync from ERP": pull the latest customer data from the ERP now (1.17.0) | ● | ● | ○ | ○ | erp-gateway |
| `flag.manage` | Toggle feature flags (global / per branch) | ● | ○ | ○ | ○ | flags |
| `device.manage` | View devices, revoke sessions, unbind device | ● | ● | ○ | ○ | devices |
| `customer.view` | View customers in scope (list, detail, plan, schedule, payments) | ● | ● | ● | ● | customers |
| `customer.export` | Export customer lists | ● | ● | ○ | ○ | customers |
| `customer.location.propose` | Propose a corrected pin | ● | ● | ● | ○ | customers |
| `customer.location.approve` | Approve/reject pin corrections; set a pin on the map (1.11.0); delete a pin (1.17.0) | ● | ● | ○ | ○ | customers |
| `tag.view` | See bad-customer suggestion, tag and history | ● | ● | ● | ● | tags |
| `tag.set` | Tag/untag (reason required) | ● | ● | ● | ○ | tags |
| `tag.approve` | Review queue: approve/revert staff-set tags, act on "balance cleared" prompts | ● | ● | ○ | ○ | tags |
| `collection.record` | Record a field collection | ● | ● | ● | ○ | collections |
| `collection.view` | View collections in scope (own only for FS) | ● | ● | ● | ● | collections |
| `collection.void` | Void a collection **not yet posted** to ERP (reason required) | ● | ● | ○ | ○ | collections |
| `collection.resolve` | Resolve conflicts | ● | ● | ○ | ○ | collections |
| `cash.view` | View cash positions (own only for FS) | ● | ● | ● | ● | cash |
| `cash.deposit.record` | Record a deposit | ● | ● | ● | ○ | cash |
| `cash.deposit.verify` | Verify/reject deposits | ● | ● | ○ | ○ | cash |
| `cash.limit.manage` | Set cash-on-hand limits per user/branch | ● | ○ | ○ | ○ | cash |
| `assignment.view` | View assignments and areas | ● | ● | ● | ● | assignments |
| `assignment.manage` | Assign customers/areas, edit areas | ● | ● | ○ | ○ | assignments |
| `handover.create` | Create a handover between staff | ● | ● | ○ | ○ | handovers |
| `handover.request` **[ADDED]** | Staff requests handover of own customers (needs manager approval) | ● | ● | ○ | ○ | handovers |
| `visit.record` | Check in / out at a customer | ● | ● | ● | ○ | visits |
| `visit.view` | View visits in scope | ● | ● | ● | ● | visits |
| `note.create` | Add notes | ● | ● | ● | ○ | notes |
| `note.view` | View notes in scope | ● | ● | ● | ● | notes |
| `promise.create` | Record/update promise-to-pay | ● | ● | ● | ○ | promises |
| `promise.view` | View promises in scope | ● | ● | ● | ● | promises |
| `attendance.record` | Own work-in/out and breaks | ○ | ○ | ● | ○ | attendance |
| `attendance.view` | View attendance of others in scope | ● | ● | ○ | ● | attendance |
| `attendance.manage` | Corrections, leave approval, shift assignment | ● | ● | ○ | ○ | attendance |
| `location.view` | Latest location map | ● | ● | ○ | ○ | location |
| `location.history.view` | Route history and stops | ● | ● | ○ | ○ | location |
| `report.view` | Reports and dashboards in scope | ● | ● | ○ | ● | reports |
| `report.export` | Export reports (CSV/XLSX/PDF) | ● | ● | ○ | ○ | reports |
| `notification.broadcast` **[ADDED]** | Send announcements to staff in scope | ● | ● | ○ | ○ | notifications |
| `audit.view` | View audit log in scope | ● | ○ | ○ | ● | audit |
| `cowork.use` **[ADDED]** | Ask colleagues to work together, accept, leave | ○ | ○ | ● | ○ | cowork |
| `cowork.view` **[ADDED]** | See co-work sessions in scope | ● | ● | ○ | ● | cowork |
| `target.view` **[ADDED]** | See daily targets in scope | ● | ● | ○ | ● | targets |
| `target.manage` **[ADDED]** | Set daily targets for staff and branch defaults | ● | ● | ○ | ○ | targets |
| `inbox.view` **[ADDED]** | "Needs attention" exceptions inbox | ● | ● | ○ | ○ | inbox |
| `leave.request` **[ADDED]** | Request leave | ○ | ○ | ● | ○ | attendance |
| `microfinance.view` | **RESERVED** — not grantable until MF-001 unblocked | — | — | — | — | microfinance |
| `microfinance.manage` | **RESERVED** | — | — | — | — | microfinance |

Rules:
- Every key is declared in exactly one module manifest (`permissions[]`). CI fails if a key is declared twice or used (`requirePermission('x')`) but not declared.
- Self-service actions need no key: own profile, own password change, own notifications, own sessions.
- Scope is separate from permission: holding `customer.view` lets a field staff see **only** customers in their assignment scope; a manager only in their branches.

### 3.2 Overrides
- **Branch override:** `{ branchId, key, effect: allow|deny }` applies to all users of a role in that branch (`role` field required).
- **User override:** `{ userId, key, effect: allow|deny }`.
- Overrides cannot grant `microfinance.*` (reserved) nor allow a BM to manage SA accounts.

### 3.3 Evaluation order
`effective(user, key)` = first match of: user override → branch override (for the user's role, any of the user's branches; **deny wins** if branches disagree) → role default. `super_admin` short-circuits to allow (except reserved). Result is cached per user for 60 s and invalidated by `rbac.changed` event.

## 4. Functional requirements

### 4.1 Authentication & sessions (module `auth`)

| ID | Requirement | Status | Phase | Repos | Test |
|---|---|---|---|---|---|
| FR-AUTH-001 | Login with phone number (BD format `01XXXXXXXXX`, normalized to `+8801XXXXXXXXX`) or username, and password. Returns access token (JWT, 15 min) and refresh token (opaque, 30 days, rotating). | active | P0 | A W M | U I E |
| FR-AUTH-002 | Token refresh with rotation; reuse of an old refresh token revokes the whole session family and is audited. | active | P0 | A W M | U I |
| FR-AUTH-003 | Password change (current + new); policy: ≥ 8 chars, not in top-10k list, not equal to phone. All other sessions revoked except current. | active | P0 | A W M | U I E |
| FR-AUTH-004 | Admin-initiated password reset produces a one-time temporary password; user must change it at next login (`mustChangePassword`). | active | P0 | A W | I E |
| FR-AUTH-005 | Login throttling: 5 failures / 15 min per account and per IP → 15 min lock; audited. | active | P0 | A | I |
| FR-AUTH-006 **[ADDED]** | App quick unlock: after first online login, 4–6 digit PIN or device biometric unlocks the app locally (offline OK). 5 wrong PINs → full re-login. | proposed | P1 | M | U D |
| FR-AUTH-007 **[ADDED]** | Device binding: a field staff account is bound to max 1 active device (configurable); login from a new device requires manager approval or unbinding. | proposed | P1 | A W M | I E |
| FR-AUTH-008 **[ADDED]** | Session list and remote logout (own and, with `device.manage`, others). | proposed | P1 | A W M | I E |
| FR-AUTH-009 **[ADDED]** | App version gate: API returns `426 UPGRADE_REQUIRED` below `settings.app.minVersion`; app shows update screen. | proposed | P0 | A M | I D |
| FR-AUTH-010 | Offline grace: if the access token expires while offline, the app keeps working locally; queued data syncs after successful refresh. If the refresh token has expired, user logs in again and the **local queue is preserved** and uploaded under that user only. | active | P1 | M A | U D |

### 4.2 RBAC (module `rbac`)

| ID | Requirement | Status | Phase | Repos | Test |
|---|---|---|---|---|---|
| FR-RBAC-001 | Roles `super_admin`, `branch_manager`, `field_staff` (+ `viewer` [ADDED]) with defaults per §3.1. | active | P0 | A W | U I |
| FR-RBAC-002 | Permission catalog endpoint lists every key with description, module and defaults, generated from manifests. | active | P0 | A W | I C |
| FR-RBAC-003 | Super admin toggles any key per branch (per role) and per user (allow/deny/inherit). | active | P0 | A W | I E |
| FR-RBAC-004 | Effective-permission view per user, showing the source of each decision (role/branch/user). | active | P0 | A W | I E |
| FR-RBAC-005 | Every permission change is audited with before/after and a required reason. | active | P0 | A W | I |
| FR-RBAC-006 | Mobile app receives effective permissions at login and in every sync pull, and hides/disables actions accordingly; server always re-checks. | active | P1 | A M | I D |
| FR-RBAC-007 | Guard: the last active super admin cannot be demoted or deactivated. | active | P0 | A | U I |

### 4.3 Users, branches, settings, flags

| ID | Requirement | Status | Phase | Repos | Test |
|---|---|---|---|---|---|
| FR-USER-001 | CRUD users: name (Bangla + English), phone, role, branchIds, employeeCode, `erpEmployeeId` (optional), photo, active flag. | active | P0 | A W | I E |
| FR-USER-002 | Deactivation revokes sessions, blocks login, and triggers a handover reminder if the user still holds assignments. | active | P0 | A W | I |
| FR-BR-001 | Branches mirrored from Laravel (`erpBranchId`, code, name bn/en, district, address, lat/lng). Read-only in FOS except local extras (duty hours override, cash limit default). The ERP has no Bangla name, district or coordinates; warehouses are mirrored too (ADR-033). | active | P0 | A W | C I |
| FR-BR-002 | Branch map point set in FOS (`PUT /branches/{id}/location`, `settings.manage`, inside Bangladesh, audited); ERP sync never clears it. Used for map centring and the "far from branch" data-quality check. | active | P1 | A W | I |
| FR-SET-001 | Org settings (key/value, typed, audited): duty hours, late threshold, break max, cash limits, geofence radius, stop dwell, retention days, min app version, receipt prefix, SMS on/off. | active | P0 | A W | U I |
| FR-FLAG-001 | Feature flags per module: global default OFF, per-branch override; registry lists owner, description, created, review-by date. | active | P0 | A W | U I |
| FR-FLAG-002 | Disabled module: routes return `403 FEATURE_DISABLED`, mobile hides entry points, admin hides menu. | active | P0 | A W M | I E |
| FR-SET-002 **[ADDED]** | Holiday calendar (national + branch-specific) and weekly off days per branch; used by attendance and due-date logic display. 1.12.0: holidays carry an `id`, can be deleted (audited), a duplicate day for overlapping branches is refused, and the list filters by branch. | active | P1 | A W | I |
| FR-SET-003 **[ADDED]** | Shifts: named duty windows (e.g. 09:00–18:00) assignable per branch/user. 1.12.0: `GET /attendance/me/shift` gives the staff member their own shift or the branch default. | active | P1 | A W | I |

### 4.4 ERP gateway & customer read model (modules `erp-gateway`, `customers`)

| ID | Requirement | Status | Phase | Repos | Test |
|---|---|---|---|---|---|
| FR-ERP-001 | ERP client with a bearer token of an integration user (ERP field API v1, erp-integration-spec v2; the ERP has no Sanctum, the API checks a hashed token); timeouts 10 s; retries with jitter for 5xx/429 only; circuit breaker (open after 5 consecutive failures, half-open after 60 s). | active | P0 | A | U C |
| FR-ERP-002 | Delta sync job pulls customers/plans/schedules/payments changed since last cursor every 5 min (configurable) and nightly full reconcile per branch. | active | P1 | A | C I |
| FR-ERP-003 | On-demand refresh of one customer (`POST /customers/{id}/refresh`) with 30 s rate limit per customer. | active | P1 | A W M | C I |
| FR-ERP-004 | ERP status indicator: last successful sync time, lag, failure count; exposed at `/system/erp-status` and shown in admin header when lag > 15 min. | active | P1 | A W | I E |
| FR-ERP-005 | "Record-only mode" fallback (setting): if Laravel write endpoint is unavailable, collections remain `received` and an export for manual office entry is available. | active | P1 | A W | I E |
| FR-ERP-006 | Real ERP shape (contract 1.13.0, ADR-033): plan = ERP invoice (installment or credit) with invoice number, items, guarantor, frequency, late fee and rolled lines; reversed payments from ERP removals; ERP directions and risk on the customer; ERP employees list to link staff (`GET /system/erp-employees`); conflicts `PLAN_CLOSED`, `DUPLICATE_SAME_DAY`, `METHOD_NOT_AVAILABLE`, `COLLECTOR_NOT_LINKED`. | active | P0 | A W M | U C I |
| FR-ERP-007 **[ADDED 2026-11-18, owner request]** | "Sync from ERP" button: `POST /system/erp-sync` (permission `erp.sync`) pulls the customers changed in the ERP since the last sync now (everything on the first run), one run at a time (Mongo lock), at most ~40 s per call; `partial: true` means call again (the next call continues where the last stopped). Never changes money; ERP down → `503 ERP_UNAVAILABLE`. | active | P1 | A W | I |
| FR-CUS-001 | Customer list scoped by role: FS = their branches since 1.19.0, or assigned (direct + area) under `customers.staffVisibility = assigned` (FR-CUS-015); BM = their branches; SA = all. Cursor-paginated (default 25, max 100). | active | P1 | A W M | I E |
| FR-CUS-002 | Filters: `overdue`, `due_today`, `promised_today`, `assigned_to_me`, `branchId`, `areaId`, `assigneeId`, `bad_suggested`, `tagged_bad`, `no_location`, `q` (name/phone/ERP code), `near` (lat,lng,radius) with sort by distance. | active | P1 | A W M | I E |
| FR-CUS-003 | Customer detail: profile, all plans with schedule, payment history (ERP + pending field collections, visually distinct), outstanding balance per plan and total, next due, days overdue, assignment, tag + suggestion, last visit, open promise, notes. | active | P1 | A W M | I E |
| FR-CUS-004 | Coordinates from Laravel validated: null, 0/0, outside Bangladesh bounds, or swapped lat/lng → `location.status = missing|invalid|suspect_swapped`; never shown as a wrong pin. | active | P1 | A W M | U C |
| FR-CUS-005 | Map endpoint returns pins for a bounding box with status colour key (overdue, due today, promised today, paid-up, bad suggested, tagged bad) and clustering hints. | active | P1 | A W M | I E |
| FR-CUS-006 | Pin popup/sheet shows name, status, outstanding, last 3 notes, last visit, open promise, and links to full timeline. | active | P1 | W M | E D |
| FR-CUS-007 | Customer timeline: merged chronological feed of payments (ERP), collections (field), visits, notes, promises, tags, handovers, location corrections. | active | P1 | A W M | I E |
| FR-CUS-008 **[ADDED]** | Pin correction: staff proposes a new pin captured from current GPS (accuracy ≤ 30 m required) with photo; manager approves/rejects; approved overlay overrides ERP coords in FOS; full history. | proposed | P1 | A W M | I E D |
| FR-CUS-009 **[ADDED]** | Data-quality report: customers with missing/invalid coords, missing phone, plan with no schedule, per branch. Approved by the owner 2026-11-17; issues also cover swapped coords, pin far from the branch, invalid and shared phones, unassigned. | active | P3 | A W | I |
| FR-CUS-010 **[ADDED]** | "As of" freshness: every balance shown with `erpFetchedAt`; app warns when > 24 h old. | proposed | P1 | A W M | U D |
| FR-CUS-012 **[ADDED 2026-11-18, owner request]** | Map pin colour by payment state (ADR-035): red = tagged bad/legal or a plan's full term over with money left; orange = two or more missed installments; yellow = one missed installment; blue = due today; green = everything due so far paid; grey = nothing left to pay. Pins, clusters (worst colour + count per colour), list items and filters (`payState`). | active | P1 | A W | I E |
| FR-CUS-013 **[ADDED 2026-11-18, owner request]** | Invoice viewer data: each installment and credit invoice with header money (subtotal, discounts, tax, total, down payment, financed, paid, settlement discount, written off, refunded, due), items with unit price and line total, credit due date, and for installments every line with due date, amount, late fee, paid, left, status, the ERP payments that paid it (date, receipt, amount), paid-on date and days late. Customer list filter `invoiceKind` (open installment / credit invoice). | active | P1 | A W | I E |
| FR-CUS-014 **[ADDED 2026-11-18, owner request]** | Delete a map pin: a manager or super admin deletes any in-scope customer's pin, whatever its source (`DELETE /customers/{id}/location`, permission `customer.location.approve`, audited `customer.location.cleared`). The customer then has no pin (`missing`), is in the "no location" list, the assignee's phone and polygon areas are updated, and the ERP sync keeps it deleted until a new pin is set (ADR-036). Idempotent. The admin panel asks the user to type a confirm word first. | active | P1 | A W M | I E |
| FR-CUS-011 **[ADDED 2026-11-17, owner request]** | Map pin (Uber style): admin/manager drops or drags a pin on a map to set any in-scope customer's coordinates directly (`POST /customers/{id}/location`, permission `customer.location.approve`, audited `customer.location.set`, kept in pin history as `direct`). Field staff pick a pin on the map too (`method: map`, with the phone position for the reviewer). A staff pin for a customer **without** a usable pin is applied at once (owner decision 2026-11-17; setting `customers.staffPinApproval` = `when_missing` default \| `always`, per branch); moving an existing pin still needs a manager. Every applied pin recomputes polygon areas and the assignee. | active | P1 | A W M | I E |
| FR-CUS-015 **[ADDED 2026-11-18, owner request]** | Field staff see every customer of their branches, assigned or not (setting `customers.staffVisibility` = `branch` default \| `assigned`, per branch); a staff member can belong to several branches (set at user creation or edit; the first is the home branch); lists show each customer's branch. Assignment still marks the staff member's own work. ADR-038. | active | P1 | A W M | I E |

**Overdue definitions** (rule module `customers/domain/status.ts`, plan length never hardcoded):
- `due_today`: any schedule line with `dueDate == today` and `lineOutstanding > 0`.
- `overdue`: any schedule line with `dueDate < today` and `lineOutstanding > 0`. `daysOverdue` = today − oldest unpaid line's dueDate.
- `promised_today`: an open promise with `promisedDate == today`.
- If Laravel provides only plan-level outstanding and no per-line paid amounts, lines are allocated oldest-first by FOS for display only (ASSUMPTION E-07), labelled "estimated".

### 4.5 Bad-customer suggestion and tag (module `tags`)

| ID | Requirement | Status | Phase | Repos | Test |
|---|---|---|---|---|---|
| FR-TAG-001 | **Suggestion rule:** a customer is suggested as bad when **any** plan has `finalDueDate < today (Asia/Dhaka)` **and** that plan's `outstanding > 0`. `finalDueDate` = the plan's end date from Laravel, or the max schedule `dueDate` if no end date exists (ASSUMPTION E-05). Never derived from a month count. | active | P1 | A | U C |
| FR-TAG-002 | The suggestion is display-only (badge + reason text, e.g. "Plan ended 12 Oct 2026, ৳8,500 outstanding"). Never auto-tags. | active | P1 | A W M | U E |
| FR-TAG-003 | Tag/untag requires `tag.set` and a reason (min 10 chars) chosen from reason codes + free text. Stored: who, when, reason, previous value, source (`web`/`app`), device location (app). | active | P1 | A W M | I E |
| FR-TAG-004 | `tag.set` default ON for field staff; super admin can toggle per branch/user (standard RBAC). | active | P1 | A | I |
| FR-TAG-005 | When a tagged customer's total outstanding becomes 0 (detected in ERP sync), the suggestion disappears, the tag remains, and users with `tag.approve` in that branch get a notification + inbox item "Balance cleared — review tag". | active | P1 | A W | I |
| FR-TAG-006 | Tag history view (immutable events). | active | P1 | A W M | I E |
| FR-TAG-007 | Optional approval mode (`tags.requireApproval`, default OFF): staff-set tag becomes `pending` until approved by `tag.approve`. | active | P1 | A W M | I E |
| FR-TAG-008 **[ADDED]** | Severity level on tag: `watch` / `bad` / `legal` (legal = handed to recovery/legal team). | proposed | P1 | A W M | U I |

### 4.6 Collections (module `collections`)

| ID | Requirement | Status | Phase | Repos | Test |
|---|---|---|---|---|---|
| FR-COL-001 | Record a collection: customerId, planId (required if customer has > 1 active plan; else auto), amountPoisha (> 0), method `cash`/`bkash`/`nagad`/`rocket`/`bank_transfer`/`other_mobile`, transactionRef (required for non-cash, regex per method), payerName (if not customer), note, GPS fix, photo (optional; setting can require for amounts > X). | active | P1 | A M | U I E D |
| FR-COL-002 | Receipt number: provisional, offline-safe, unique: `{BRANCHCODE}-{STAFFCODE}-{YYMMDD}-{SEQ4}` from a per-device sequence; plus optional physical receipt book number. Laravel's official receipt/voucher no. stored as `erpReceiptNo` after posting. | active | P1 | A M | U I |
| FR-COL-003 | Offline-first: saved to local DB first, shown as `queued`; syncs automatically when online; manual "Sync now". | active | P1 | M | U D |
| FR-COL-004 | Every collection carries a client-generated UUIDv7 `idempotencyKey`. field-api stores it with a unique index; a retry with the same key and same payload hash returns the original result (`200`, `replayed: true`); same key with different payload → `409 IDEMPOTENCY_MISMATCH`. The same key is forwarded to Laravel. | active | P1 | A M | U I C |
| FR-COL-005 | Lifecycle: `received → posting → posted` or `→ conflict → resolved_posted | resolved_refund | resolved_voided`; also `voided` (before posting). Every transition is an event + audit entry. | active | P1 | A W M | U I |
| FR-COL-006 | Field-api **never drops** a well-formed collection: business problems (plan settled, amount > outstanding, customer reassigned, ERP rejection) create a **conflict** with a code, visible to the staff (app "Problems" tab + push) and to managers (inbox). | active | P1 | A W M | I E |
| FR-COL-007 | Conflict resolution by `collection.resolve`: post as advance/other plan, post anyway (if ERP allows), refund to customer (records refund proof), void with reason. Staff sees outcome. | active | P1 | A W M | I E |
| FR-COL-008 | Posting to Laravel via outbox with retry (exponential, max 24 h), then `posting_failed` alert. | active | P1 | A | I C |
| FR-COL-009 | Void before posting (`collection.void`) with reason; posted collections can only be reversed in Laravel (FOS never reverses money). FOS reflects reversals reported by ERP sync (`erpStatus = reversed`). | active | P1 | A W | I C |
| FR-COL-010 | Collection list/filter for managers: date range, staff, branch, method, status; totals by method. | active | P1 | A W | I E |
| FR-COL-011 **[ADDED]** | Digital receipt: app renders a receipt image (Bangla) to share via WhatsApp/SMS intent; server version reachable by short signed link (proposed SMS). | proposed | P1 | A M | U D |
| FR-COL-012 **[ADDED]** | SMS receipt to customer's registered phone on `received` (and on `posted` if different amount): "৳X received by {staff}, receipt {no}. Hotline …". Behind flag `module.sms`. | proposed | P4 | A | I |
| FR-COL-013 **[ADDED]** | Anomaly flags on each collection: `far_from_pin` (> geofence radius, default 300 m), `mock_location`, `clock_skew` (> 5 min), `late_sync` (> 12 h after recording), `duplicate_txn_ref` (same mobile txn ID seen before). Flags never block, they feed the inbox. | proposed | P1 | A W | U I |
| FR-COL-014 **[ADDED]** | Daily reconciliation report: FOS posted totals vs. Laravel payments with source=field per branch/day; mismatches listed. | proposed | P3 | A W | I C |
| FR-COL-015 **[ADDED]** | Daily target per staff (amount and visits), shown as progress on app home and manager dashboard. Approved by the owner 2026-11-17: dated personal targets and branch defaults (module `targets`); visits are measured as visit credit; no target on weekly off, holiday or approved leave. | active | P3 | A W M | I |

### 4.7 Cash on hand and deposits (module `cash`)

| ID | Requirement | Status | Phase | Repos | Test |
|---|---|---|---|---|---|
| FR-CASH-001 | Cash on hand per staff = Σ cash collections (not voided, not refunded) − Σ verified + pending deposits. Mobile-payment collections excluded. | active | P1 | A M W | U I |
| FR-CASH-002 | Limit per staff (default from branch, default 50,000 BDT, setting). Warning at 80 % (app banner + manager notification), at 100 % app shows a blocking dialog requiring "deposit first" — configurable `cash.limitMode = warn|block` (default `warn`). Enforced offline with local data. | active | P1 | A M W | U I D |
| FR-CASH-003 | Deposit record: amount, destination `branch_cashier`/`bank`/`manager`, reference, slip photo (required for bank), time, GPS. Status `pending → verified | rejected`. | active | P1 | A M W | I E |
| FR-CASH-004 | Verification by `cash.deposit.verify`; rejection requires reason; staff notified. | active | P1 | A W | I E |
| FR-CASH-005 | Cash positions dashboard: per staff on-hand, oldest undeposited cash age, over-limit list. | active | P1 | A W | I E |
| FR-CASH-006 **[ADDED]** | End-of-day closing in app: summary of cash and mobile collections, deposits, remaining on hand; staff confirms; mismatch note optional. | proposed | P1 | A M | U D |

### 4.8 Assignment & handover (modules `assignments`, `handovers`)

| ID | Requirement | Status | Phase | Repos | Test |
|---|---|---|---|---|---|
| FR-ASG-001 | Areas: named polygons or lists of ERP area codes / unions / villages per branch (ASSUMPTION E-11 whether Laravel has area codes). | active | P1 | A W | I E |
| FR-ASG-002 | Assign an area or individual customers to staff; one staff can hold several areas; a customer has exactly one **primary** assignee at a time; direct assignment overrides area assignment. | active | P1 | A W | U I E |
| FR-ASG-003 | Bulk assign (select many on table or draw on map). | active | P1 | W A | E |
| FR-ASG-004 | Assignment history per customer and per staff (effective from/to). Since 1.11.0 the customer timeline lists direct assignments (started/ended, by whom). | active | P1 | A W | I |
| FR-ASG-005 | Unassigned-customers report and warning on dashboard. | active | P1 | A W | I |
| FR-HO-001 | Handover: from-staff, to-staff, scope (areas and/or customers), reason, effective date; status `pending_acceptance → accepted | rejected | cancelled | expired (72 h)`. | active | P1 | A W M | U I E |
| FR-HO-002 | Receiver accepts/rejects in app (push notification). Until acceptance the original assignee keeps the customers. | active | P1 | A M | I D |
| FR-HO-003 | After acceptance notes, promises, visits and tags remain visible to the new assignee; open promises transfer; audit + history kept. | active | P1 | A W M | I E |
| FR-HO-004 | Handover summary for receiver: customers, total outstanding, overdue count, open promises, pending conflicts. | active | P1 | A M | I D |
| FR-HO-005 | Cash on hand is **not** transferred by handover; outgoing staff must deposit (warning shown). | active | P1 | A M | U |
| FR-HO-006 **[ADDED]** | Temporary cover: handover with `endDate` auto-reverts (leave cover). | proposed | P1 | A W | U I |
| FR-HO-007 **[ADDED]** | Staff-initiated handover request (`handover.request`) → manager approves → receiver accepts. | proposed | P4 | A W M | I |

### 4.9 Visits, notes, promises (modules `visits`, `notes`, `promises`, `media`)

| ID | Requirement | Status | Phase | Repos | Test |
|---|---|---|---|---|---|
| FR-VIS-001 | Check-in at a customer: GPS fix (accuracy, mock flag), device time, server time, distance to pin; outcome code; optional checkout time. | active | P1 | A M | U I D |
| FR-VIS-002 | Photo: **camera only** (no gallery), compressed (long edge 1280 px, JPEG q≈70, ≤ 250 KB), watermark overlay with date/time, staff code and coordinates; EXIF stripped except time. | active | P1 | M | U D |
| FR-VIS-003 | Photos upload via presigned PUT URL to object storage, then `confirm`; queued offline with retries; visit syncs without waiting for photo. | active | P1 | A M | I D |
| FR-VIS-004 | Outcome codes: `paid`, `partial_paid`, `promised`, `not_home`, `refused`, `shifted_address`, `customer_dead`, `product_returned_request`, `other` (configurable list). | active | P1 | A M W | U |
| FR-VIS-005 | Visit suggestion: if staff dwells ≥ `stops.minDwellMin` (default 5 min) within `stops.radiusM` (default 60 m) of a customer pin and no visit exists, app suggests "Record visit for X?" (phase 2 with tracking; phase 1 on app open near pin). | active | P2 | M A | U D |
| FR-NOTE-001 | Notes on a customer: text (≤ 2000 chars), optional voice note **[ADDED]** (≤ 60 s), category, visibility (all in branch). Editable by author for 15 min, then immutable (corrections as new note). | active | P1 | A W M | I E |
| FR-PRM-001 | Promise-to-pay: customer, plan, promised date (≥ today, ≤ +60 days), promised amount, note. One open promise per plan; new promise supersedes old (history kept). | active | P1 | A W M | U I E |
| FR-PRM-002 | Reminder on promised date: local notification at 09:00 Dhaka (works offline) + FCM backup + appears in "Promised today". | active | P1 | A M | I D |
| FR-PRM-003 | Promise auto-evaluation nightly: `kept` if ERP + field payments since promise ≥ promised amount by end of promised date (+ grace days setting, default 1); `partially_kept`; `broken`. | active | P1 | A | U I |
| FR-PRM-004 | Promise fulfilment rate per staff/branch for reports. | active | P3 | A W | U I |
| FR-MED-001 | Media service: presigned upload/download URLs (5 min expiry), content-type and size validation, SHA-256 dedupe, private bucket, thumbnail generation. | active | P1 | A | I |

### 4.9a Co-work **[ADDED 2026-11-16, owner request]** (module `cowork`)
| ID | Requirement | Status | Phase | Repos | Test |
|---|---|---|---|---|---|
| FR-CW-001 | A field staff member asks one or more colleagues of the same branch to work together for the business day; each invitee accepts or rejects. Online only. At most `cowork.maxMembers` (5) people; a person is an accepted member of one open session at a time. | active | P2 | A M | U I D |
| FR-CW-002 | A member can leave; recording work-out leaves automatically. The session ends at Dhaka midnight, or when fewer than two accepted members remain and no invitation is pending. | active | P2 | A M | U I |
| FR-CW-003 | A visit sent with `coWorkSessionId` is stored as a co-work visit with the session members accepted at check-in time as participants. It stays one record by the recorder. A recorder who was not an accepted member then gets a single visit flagged `cowork_invalid`. | active | P2 | A M | U I D |
| FR-CW-004 | Managers see co-work sessions (members, times, visits) and can filter visits by single / co-work. | active | P2 | A W | I |
| FR-CW-005 | Staff statistics separate single visits from co-work visits. Every participant gets credit for a joint visit, weighted for targets by `cowork.visitCredit` (0–1, default 1). **Collections and cash are never shared:** they count only for the person who recorded them (cash accountability). | active | P2 | A W | U I |

### 4.10 Attendance (module `attendance`)

| ID | Requirement | Status | Phase | Repos | Test |
|---|---|---|---|---|---|
| FR-ATT-001 | Events: `work_in`, `break_start`, `break_end`, `work_out` with GPS fix, mock flag, device and server time; front-camera photo at each event **[ADDED]** — required by default at all four (settings `attendance.selfieRequired`, `attendance.selfieEvents`; owner decision 2026-11-16); an event without one is stored and flagged `no_selfie`. | active | P1 | A M | U I D |
| FR-ATT-002 | State machine prevents invalid sequences (e.g. break_end without break_start); offline events ordered by device time and validated on sync; anomalies flagged not rejected. | active | P1 | A M | U I |
| FR-ATT-003 | Late = work_in after shift start + `attendance.lateGraceMin` (default 15). Absent = no work_in on a working day (not holiday/weekly off/approved leave) by shift end. | active | P1 | A | U |
| FR-ATT-004 | Summary per staff/day/month: present, late (minutes), absent, total break minutes, over-break, duty minutes, first/last event. | active | P1 | A W | U I E |
| FR-ATT-005 | Auto work-out: if no work_out by shift end + 3 h, system closes the day with `auto_closed` flag and stops tracking. | active | P1 | A M | U I |
| FR-ATT-006 | Corrections by `attendance.manage` with reason; original kept; audited. | active | P1 | A W | I E |
| FR-ATT-007 **[ADDED]** | Work-in geofence: optional requirement to be within X m of branch or first assigned area (setting, default off). | proposed | P1 | A M | U |
| FR-ATT-008 **[ADDED]** | Leave requests (type, dates, reason) → manager approval → counted in absence logic. 1.12.0: the requester can withdraw a pending request (`cancelled`); the decision reason is shown to the requester; managers filter by period and person. | active | P4 | A W M | I E |

### 4.11 Location tracking (modules `location`, `stops`)

| ID | Requirement | Status | Phase | Repos | Test |
|---|---|---|---|---|---|
| FR-LOC-001 | Tracking runs **only** between work_in and work_out, and only within shift window + 3 h. During lunch break tracking pauses when `location.trackDuringBreak = false` (default **false**, see OD-05). Server rejects points outside duty (`422 OFF_DUTY`). | active | P2 | A M | U I D |
| FR-LOC-002 | Adaptive sampling: speed > 15 km/h (bike) → every 15–20 s / 50 m; 3–15 km/h (walk) → 30–60 s; stationary (activity still, or < 1 km/h for 2 min) → 2–5 min; near customer pin and stationary → 3 min. All values in settings. | active | P2 | M | U D |
| FR-LOC-003 | Discard on device and server: accuracy > 50 m, implied speed > 120 km/h from previous accepted point, timestamp in future (> 2 min), duplicates. | active | P2 | A M | U |
| FR-LOC-004 | Offline queue (local DB), batch upload up to 500 points / request, gzip; oldest first; queue cap 20,000 points. | active | P2 | M A | U I D |
| FR-LOC-005 | Mock-location detection (Android `isMock`/`isFromMockProvider`, developer options on, known mock apps) → flag point and event; inbox alert once per day per staff. | active | P2 | M A | D I |
| FR-LOC-006 | Latest location map: one marker per on-duty staff with last-seen age (fresh < 5 min, stale 5–30, lost > 30), battery %, on break, mock flag. Not live-streaming; refresh on open + manual + 60 s polling while page visible. | active | P2 | A W | I E |
| FR-LOC-007 | Route history for staff+date: polyline (simplified, Douglas-Peucker 10 m), stops with dwell time, visits/collections overlaid, gaps shown dashed. | active | P2 | A W | I E |
| FR-LOC-008 | Stop detection: cluster of consecutive points within `stops.radiusM` (60 m) for ≥ `stops.minDwellMin` (5 min); matched to nearest customer pin within radius → "customer stop". | active | P2 | A | U I |
| FR-LOC-009 | Retention: raw points TTL `location.retentionDays` (default 90, ASSUMPTION — to confirm); stops 12 months; daily summaries 24 months. | active | P2 | A | I |
| FR-LOC-010 | Heartbeat every 10 min while on duty (battery, GPS on/off, permission state, app version) to detect "tracking stopped" vs. "no movement". | active | P2 | A M | I D |
| FR-LOC-011 | Privacy: staff sees in app "Tracking ON — on duty" persistent notification; privacy notice version accepted before first work-in. | active | P2 | M A | D |
| FR-LOC-012 **[ADDED]** | Daily distance and time-in-field summary per staff (used in reports, fuel allowance). | proposed | P3 | A W | U I |

### 4.12 Notifications (module `notifications`)

| ID | Requirement | Status | Phase | Repos | Test |
|---|---|---|---|---|---|
| FR-NOT-001 | FCM device token registration per session; topic-free (send per token). | active | P1 | A M | I D |
| FR-NOT-002 | Notification types: promise reminder, handover pending/accepted/rejected, collection conflict, conflict resolved, deposit verified/rejected, cash limit, tag review, permission changed, announcement, app update. | active | P1 | A M W | I D |
| FR-NOT-003 | In-app notification center (app and admin bell) with read state; stored 90 days. | active | P1 | A M W | I E |
| FR-NOT-004 | Quiet hours (no push 21:00–08:00 except critical). | active | P1 | A | U |
| FR-NOT-005 **[ADDED]** | Broadcast announcements to a branch/role with optional "must acknowledge". 1.12.0: the sender sees who read it and when (`GET /broadcasts/{id}/recipients`); staff can tap "read" offline (sync mutation `broadcast_ack`). | active | P4 | A W M | I E |

### 4.13 Inbox, dashboard, search **[ADDED]** (module `inbox`, `dashboard`)

| ID | Requirement | Status | Phase | Repos | Test |
|---|---|---|---|---|---|
| FR-INB-001 **[ADDED]** | "Needs attention" inbox aggregating: collection conflicts, posting failures, over-limit cash, unverified deposits > 24 h, mock GPS, tracking stopped while on duty, late sync, pending handovers > 24 h, tag reviews, pin proposals, unassigned customers, ERP sync stale. Each item: severity, assignee (branch manager), resolve/snooze, link. | proposed | P1 | A W | I E |
| FR-DSH-001 | Overview dashboard: today's collected (cash/mobile), vs. target, visits, promises due/kept, present/late/absent, cash on hand total, conflicts open, ERP sync health; branch selector. | active | P1 | A W | I E |
| FR-SRCH-001 **[ADDED]** | Global search (Ctrl/⌘+K) across customers (name, phone, ERP code), staff, receipts. | proposed | P1 | A W | I E |

### 4.14 Reports (module `reports`)

| ID | Requirement | Status | Phase | Repos | Test |
|---|---|---|---|---|---|
| FR-REP-001 | Staff performance daily and monthly: visits, unique customers visited, collections (count, amount by method), promise fulfilment rate, attendance (present, late, break), time in field, distance. | active | P3 | A W | U I E |
| FR-REP-002 | Branch overdue trend (daily snapshot of overdue count/amount, aging buckets 1–30, 31–60, 61–90, 90+) and collection trend. | active | P3 | A W | U I |
| FR-REP-003 | Bangla UI and reports, Asia/Dhaka time, Bangla digits optional; Bangla PDF with embedded font (owner approved building it 2026-11-17, OD-26 closed). | active | P3 | A W | E D |
| FR-REP-004 | Exports CSV/XLSX/PDF as async job, stored in object storage 7 days, download via signed URL, audited. | active | P3 | A W | I E |
| FR-REP-005 **[ADDED]** | Leaderboard (opt-in setting) and staff self-view of own monthly performance in app. Approved by the owner 2026-11-17; managers always see it, staff only when `reports.leaderboardVisibleToStaff` is on (OD-15). | active | P3 | A M W | I |
| FR-REP-006 **[ADDED]** | Scheduled email/push digest for managers (daily 20:00 summary). | proposed | P4 | A | I |

### 4.15 Audit (module `audit`)

| ID | Requirement | Status | Phase | Repos | Test |
|---|---|---|---|---|---|
| FR-AUD-001 | Append-only audit log for: money (collections, voids, resolutions, deposits), location edits (pin corrections, attendance corrections), handovers, tags, permission and role changes, settings and flag changes (incl. branch map points, `branch.location_set`), logins/failed logins, exports, device unbinds. | active | P0 | A | U I |
| FR-AUD-002 | Entry: `actorId`, `actorRole`, `action`, `entity`, `entityId`, `branchId`, `before`, `after`, `reason`, `ip`, `userAgent`/`deviceId`, `at`, `requestId`, hash chain (`prevHash`) for tamper evidence. | active | P0 | A | U |
| FR-AUD-003 | Audit viewer with filters (actor, action, entity, date) and diff view. | active | P1 | A W | E |
| FR-AUD-004 | Audit log cannot be modified or deleted through the API; retention 8 years for money, 3 years other (OD-09). | active | P0 | A | I |

### 4.16 Sync (module `sync`)

| ID | Requirement | Status | Phase | Repos | Test |
|---|---|---|---|---|---|
| FR-SYNC-001 | Pull: `GET /sync/pull?cursor=` returns changed entities in the user's scope since cursor (customers, assignments, promises, notes, visits, tags, handovers, settings subset, permissions, cash position), with tombstones for removed scope; page ≤ 500 changes. | active | P1 | A M | I C |
| FR-SYNC-002 | Push: `POST /sync/push` with ordered mutations (each with `mutationId`); per-item result `applied | replayed | conflict | rejected`; partial success allowed; app retries only non-final items. | active | P1 | A M | U I |
| FR-SYNC-003 | Dependency order on device: visit → media → note/promise/collection referencing it; local ids mapped to server ids. | active | P1 | M | U |
| FR-SYNC-004 | Server time offset returned on every sync; app stores offset for clock-skew flags. | active | P1 | A M | U |
| FR-SYNC-005 | Sync center in app: queued count by type, last success, errors with human messages, retry; managers see per-device sync health in admin. | active | P1 | M W A | D E |
| FR-SYNC-006 | Initial sync for a fresh device ≤ 2 min on 3G for 500 assigned customers (compressed). | active | P1 | A M | D |

### 4.17 Microfinance (reserved, module `microfinance`)

| ID | Requirement | Status | Phase | Repos | Test |
|---|---|---|---|---|---|
| FR-MF-001 | Reserve module boundary `microfinance` with manifest, permission namespace `microfinance.*`, flag `module.microfinance` (default OFF, cannot be enabled until `settings.microfinance.legalApproved = true` set by super admin with document reference). No routes, no collections, no UI. | active | P0 | A W M | U |
| FR-MF-002 | Documented rule: microfinance data in separate collections with prefix `mf_` and preferably a separate database/cluster; separate permission set; MRA legal review before any implementation. | active | P0 | A | — |

## 5. Non-functional requirements

| ID | Requirement | Target / rule | Test |
|---|---|---|---|
| NFR-SEC-001 | HTTPS only (TLS 1.2+), HSTS, no plain HTTP. | — | I |
| NFR-SEC-002 | Least privilege: Laravel integration user has only integration endpoints; Mongo user per environment with role limited to its DB; S3 key limited to one bucket. | — | manual review |
| NFR-SEC-003 | Short-lived access tokens (15 min), rotating refresh tokens (30 days app, 12 h admin idle / 7 days absolute). | — | U I |
| NFR-SEC-004 | MongoDB Atlas: SCRAM auth, IP access list (API server egress IPs only), TLS, encryption at rest, no `0.0.0.0/0`. | — | checklist |
| NFR-SEC-005 | No secrets in repos; `.env.example` with names only; secret scanning in CI (gitleaks). | — | CI |
| NFR-SEC-006 | Input validation on every route (zod), output filtering by scope; rate limits (100 req/min/user default, auth 10/min/IP). | — | I |
| NFR-SEC-007 | Mobile: local DB encrypted (SQLCipher), tokens in Android Keystore via secure storage, screenshot blocking on money screens (FLAG_SECURE, setting), root/emulator signal. | — | D |
| NFR-SEC-008 | OWASP ASVS L2 checklist reviewed before go-live. | — | manual |
| NFR-PRIV-001 | Staff informed of tracking; location only during duty; versioned privacy notice acceptance stored. | — | D I |
| NFR-PRIV-002 | Location points retention TTL (configurable, default 90 d); retention jobs logged. | — | I |
| NFR-PERF-001 | API p95 < 300 ms for list/detail at 100 staff; sync push of 50 mutations < 2 s. | — | load test (k6) |
| NFR-PERF-002 | App cold start < 3 s on 2 GB RAM Android 9; list scroll 60 fps target, no jank > 100 ms; APK < 30 MB. | — | D |
| NFR-PERF-003 | All lists paginated (cursor); no unbounded queries; responses gzip/br. | — | I |
| NFR-PERF-004 | Weak network: requests time out at 20 s, retry with backoff; sync works on 2G (EDGE) for small batches. | — | D |
| NFR-REL-001 | Daily backups (Atlas continuous backup/snapshots) with **monthly tested restore** into staging; RPO ≤ 24 h (≤ 1 h with PITR), RTO ≤ 4 h. | — | runbook drill |
| NFR-REL-002 | Idempotent sync and ERP posting; outbox survives restarts. | — | I |
| NFR-REL-003 | Graceful degradation when Laravel is down: app and admin keep working with cached data; posting queues. | — | I E |
| NFR-REL-004 | Uptime target 99.5 % monthly for field-api. | — | monitoring |
| NFR-MNT-001 | Module boundaries enforced by lint (dependency-cruiser / eslint-plugin-boundaries / Dart import lint). | — | CI |
| NFR-MNT-002 | Contract tests against recorded Laravel responses; OpenAPI conformance tests for every endpoint. | — | C |
| NFR-MNT-003 | Mongo migrations versioned (migrate-mongo style), forward-only, idempotent. | — | I |
| NFR-MNT-004 | Feature flags for every non-core module, default OFF. | — | U |
| NFR-MNT-005 | Docs updated in the same PR as the change (CI check that `docs/CHANGELOG.md` changed when `src/` changed). | — | CI |
| NFR-OBS-001 **[ADDED]** | Structured JSON logs (pino) with requestId, userId, no PII in logs (phone masked); error tracking (Sentry-compatible); uptime + ERP lag alerts. | — | I |
| NFR-A11Y-001 | Bangla font (Noto Sans Bengali / Hind Siliguri) with correct conjuncts; English fallback Inter. | — | D E |
| NFR-A11Y-002 | Tap targets ≥ 48 dp (app), ≥ 40 px (web, 44 on touch). | — | D E |
| NFR-A11Y-003 | WCAG 2.2 AA contrast (4.5:1 text, 3:1 large text/icons) in light and dark themes; status never shown by colour alone. | — | E D |
| NFR-A11Y-004 | Font scaling to 130 % without layout breakage (app); keyboard navigation and visible focus (web). | — | D E |
| NFR-I18N-001 | Bangla default, English toggle; all strings in resource files; dates `১৫ নভেম্বর ২০২৬` / `15 Nov 2026`; currency `৳১২,৫০০` with Indian-style grouping (12,50,000). | — | U |

## 6. Traceability summary
The full FR → module → test matrix is in `07-test-plan.md §8`. Self-review results are in `08-decisions.md §4`.
