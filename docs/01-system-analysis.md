# 01 — System Analysis (field-api's role in the whole system)

> Spec version 1.0.0 · 2026-11-15 · Status: initial specification
> This file is the **system-wide** analysis. `admin-web` and `staff-app` have their own 01 files that point back here for shared context.

---

## 1. Purpose

Howlader Electronics sells electronics on installment, credit and down payment across 2–3 districts and several branches. An existing Laravel ERP (production, multi-branch) owns customers, installment plans, schedules, payments and balances.

The **Field Operations System (FOS)** adds what the ERP does not do:

- field staff collect installments at the customer's door, even with weak or no network;
- visits, notes, photos and promises-to-pay are recorded where they happen;
- attendance and duty-hour location give managers an honest picture of field work;
- managers and admins monitor, assign, hand over, reconcile cash and review exceptions from a web dashboard.

**Money truth always stays in Laravel.** FOS records *what happened in the field* and forwards payments to Laravel. FOS never computes an official balance.

## 2. System context

```
                    ┌──────────────────────────────┐
                    │  Laravel ERP (existing, prod) │  ← source of truth for money
                    │  + new /api/integrations/     │     (customers, plans, schedules,
                    │    field/v1 endpoints (later) │      payments, balances)
                    └──────────────▲───────────────┘
                                   │ HTTPS, Sanctum token (integration user)
                                   │ pull: delta sync of customers/plans/payments
                                   │ push: payments with Idempotency-Key
┌───────────────┐   HTTPS /api/v1  ┌┴──────────────────┐   S3 API    ┌────────────────┐
│  staff-app    │ ───────────────► │    field-api       │ ──────────► │ Object storage │
│  Flutter      │ ◄─────────────── │ Node.js + TS       │  presigned  │ (S3-compatible)│
│  offline-first│   sync push/pull │ Fastify + Mongoose │ ◄───────────┤ photos, slips, │
│  Android      │                  │                    │             │ exports        │
└──────┬────────┘                  └──┬───────┬────────┘             └────────────────┘
       │ FCM push                     │       │ MongoDB Atlas (field data only)
       │                              │       ▼
       │                   ┌──────────┴─┐  ┌──────────────┐
       └──────────────────►│  Firebase  │  │ MongoDB Atlas│
                           │  (FCM)     │  └──────────────┘
                           └────────────┘
┌───────────────┐   HTTPS /api/v1
│  admin-web    │ ───────────────► field-api   (never talks to Laravel directly)
│  Next.js CSR  │
└───────────────┘
   Map tiles: OSM-compatible tile provider via a swappable `TileProvider` config (both clients).
   Optional (proposed): SMS gateway for customer receipts, called only by field-api.
```

### Rules that follow from the context
1. `admin-web` and `staff-app` **only** talk to `field-api` (plus map tiles, FCM and presigned object-storage URLs). They never call Laravel.
2. `field-api` is the **only** component holding Laravel credentials.
3. `field-api` keeps a **read-model cache** of Laravel data (customers, plans, schedules, recent payments) so the app can work offline and Laravel is not hammered. Every cached value carries `erpFetchedAt`. The UI always shows "as of" time for balances.
4. Field-collected payments live in `field-api` with a lifecycle (`received → posting → posted | conflict → …`) until Laravel confirms them. Before confirmation they are shown as **"pending in ERP"**, never as paid.

## 3. Actors and roles

| Actor | Count now → planned | Channel | Notes |
|---|---|---|---|
| Super admin | 1–2 | admin-web | Owner / head office. Full access, permission toggles, feature flags. |
| Branch manager | 1 per branch (~5–10) | admin-web (desktop + phone browser), optionally staff-app | Scoped to their branches. |
| Field staff | 20–30 → ~100 | staff-app (low-end Android) | Several on motorbikes. Scoped to assigned customers/areas. |
| Laravel integration user | 1 | server-to-server | Sanctum token, least privilege. |
| Customer | thousands | none directly | Optional SMS receipt (proposed). |
| Laravel maintainer | 1 | — | Implements the integration endpoints later. |

**Flag (scope contradiction, minor):** the brief says admin-web is "used by 1–2 people" but also that "branch managers monitor from a web dashboard". With one manager per branch the real number is ~5–12 web users. This does **not** change the CSR decision; it means admin-web must be fully RBAC-scoped per branch and must be usable on a manager's phone browser. Designed accordingly.

## 4. Data ownership

| Data | Owner (truth) | FOS copy | Write path from FOS |
|---|---|---|---|
| Customers, addresses, phone | Laravel | cache `erp_customers` | none (read only) |
| Customer coordinates | Laravel | cache + `customer_overlays.locationOverride` | staff proposes → manager approves → overlay; optional write-back endpoint (ASSUMPTION E-14) |
| Installment plans, schedules | Laravel | embedded in `erp_customers.plans[]` | none |
| Payments, balances | Laravel | cache `erp_customers.plans[].outstanding`, `recentPayments[]` | `POST payments` with Idempotency-Key |
| Field collections (pre-ERP) | field-api | `collections` | — |
| Branches | Laravel | `branches` mirror | none |
| Users, roles, permissions | field-api | — | — |
| Assignments, areas, handovers | field-api | — | — |
| Visits, notes, promises, photos | field-api (+ object storage) | — | — |
| Bad-customer tag | field-api | `customer_overlays.tag` + `tag_events` | optional write-back (proposed, ASSUMPTION E-15) |
| Attendance, location, stops | field-api | — | — |
| Cash on hand, deposits | field-api | `cash_deposits`, derived positions | optional (Open decision OD-07) |
| Audit log | field-api | — | — |

## 5. Key flows (summary — detailed sequences in 04-architecture.md)

1. **Morning:** staff opens app → PIN/biometric unlock → *Work-in* (GPS + optional selfie) → app pulls delta (assigned customers, due today, promises today, handovers) → tracking starts (phase 2).
2. **Collection at the door:** pick customer → *Collect* → amount + method (cash / bKash / Nagad / Rocket / bank) + transaction ID if mobile → receipt number generated offline → saved locally with `idempotencyKey` → shown as *queued* → synced when online → field-api posts to Laravel → status *posted* or *conflict* → staff and manager see the result.
3. **Visit without payment:** check-in (camera-only photo, GPS, time) → outcome (not home / refused / promised / partial) → note → promise date → local reminder on the date.
4. **Cash:** cash on hand grows with each cash collection → limit warnings → deposit to branch / bank with slip photo → manager verifies → cash on hand drops.
5. **Handover:** manager (or staff, if allowed) creates handover → receiver accepts → customers move, notes/promises stay visible, history kept.
6. **Evening:** end-of-day summary (collected, deposited, visits, promises) → *Work-out* → tracking stops.
7. **Admin random check:** latest-location map, route history with stops, "Needs attention" inbox (conflicts, cash over limit, mock GPS, late sync, unaccepted handovers, tag reviews).

## 6. Analysis of the brief

### 6.1 Contradictions and ambiguities found (and how they are resolved)

| # | Finding | Resolution in this spec |
|---|---|---|
| C-1 | Admin-web "1–2 users" vs. managers monitoring from web. | Design for ~15 web users, RBAC-scoped (see §3). Fixed decisions unchanged. |
| C-2 | Permission key `tag.approve` is named but no approval flow is described; staff can set tags directly. | `tag.set` sets/unsets directly. `tag.approve` = review queue for tags set by staff and for "balance cleared — review tag" prompts. Optional setting `tags.requireApproval` (default OFF) makes staff-set tags "pending" until approved. |
| C-3 | Coordinates come from Laravel (read-only), but field staff are the ones who know the true location. | Staff can *propose* a pin correction (GPS-captured at the door). Manager approves → stored as FOS overlay used by maps and stop detection. Optional write-back to Laravel later. |
| C-4 | Location is phase 2–3, but mock-location detection and "near the customer" checks matter for check-ins and collections from phase 1. | Single-shot GPS fix + mock check + distance-to-pin are captured on every check-in, collection and attendance event from phase 1. Continuous tracking stays phase 2. |
| C-5 | Location points deleted after 90 days vs. monthly "time in field" reports and disputes. | Daily aggregates (`location_daily_summaries`: distance, time moving, time at stops, stops count) are computed nightly and retained 24 months; raw points follow the configurable TTL. |
| C-6 | "Offline-first" + "cash-on-hand limit" — limit must hold while offline. | App enforces the limit locally from last synced position + local unsynced cash; server re-checks. |
| C-7 | "Receipt number" — who issues it while offline? | Offline-safe provisional receipt number from a per-device allocated block (see ADR-012). Laravel's official receipt/voucher number is stored after posting. Physical receipt book number is an optional extra field. **Open decision OD-01.** |
| C-8 | "Conflicts never silently dropped" vs. money already physically collected. | field-api **never rejects** a field collection for business reasons; it stores every one, and conflicts go to a resolution queue. Only malformed/unauthorised requests are rejected. |
| C-9 | "Feature flag default OFF" for every module vs. a working product on day one. | Flags default OFF in code; a release **seed profile** turns on the phase-1 modules in production after acceptance. Core modules (auth, rbac, audit, settings, health) are not flaggable. |
| C-10 | Microfinance is a separate business. | Separate module boundary, separate permission namespace, and a rule that its data must live in separate collections (and preferably a separate database) because it is a different legal entity. |

### 6.2 Missing pieces the brief did not mention (added to scope, marked `[ADDED]` in 02-requirements)
Grouped by why a premium client will ask for them:

- **Fraud and trust controls** — SMS receipt to customer (proposed), collection-far-from-pin flag, device clock-skew detection, rooted/emulator/mock GPS signals, device binding, late-sync flags, receipt-number sequence gaps report, photo EXIF/time checks, end-of-day cash reconciliation.
- **Manager productivity** — "Needs attention" inbox, today's route/visit plan, global search, saved table views, bulk assignment by area, CSV/Excel export, one-click customer timeline.
- **Staff productivity** — Today screen with priorities, sort by distance, call/navigate buttons, share receipt image, quick outcome codes, PIN/biometric unlock, Bangla/English toggle, sunlight high-contrast mode, end-of-day summary.
- **Operations** — app minimum-version gate and kill switch, remote logout/device management, sync monitor, system health page, holiday calendar and shift config, attendance corrections with audit, leave requests (proposed), broadcast announcements.
- **Data quality** — coordinate correction workflow, "missing coordinates" report, ERP sync freshness indicator, duplicate-customer hint (proposed).
- **Compliance** — tracking consent screen with versioned privacy notice, retention jobs, audit viewer, data export for a staff member on request.

### 6.3 Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R-1 | Laravel integration endpoints late, incomplete or different from assumptions. | High | High | ERP gateway behind an interface with a **mock ERP** server and recorded fixtures; contract tests; assumptions table (now resolved in erp-findings.md §3, 2026-11-18); phase-1 can run in "record-only" mode (collections stay `received`, exported for manual entry) until Laravel posting exists. |
| R-2 | Double counting or lost money in offline sync. | Medium | Critical | Client-generated UUIDv7 idempotency key end-to-end (app → field-api → Laravel); payload hash check; outbox with retries; daily reconciliation report FOS vs. Laravel. |
| R-3 | Coordinate data quality in Laravel (null, 0,0, swapped lat/lng, branch address used for all). | High | Medium | Validation rules (Bangladesh bbox 20.5–26.7 N, 88.0–92.7 E), "no-pin" state, correction workflow, data-quality report. |
| R-4 | Battery drain and Android OEM background killing (Xiaomi, Oppo, Vivo, Realme, Samsung). | High | High | Foreground service with persistent notification during duty only, activity-recognition-driven adaptive sampling, OEM battery-whitelist guide screen, heartbeat gap detection, decision ADR-009 on the plugin. |
| R-5 | Legal/privacy: employee tracking, customer photos, data residency, microfinance licensing. | Medium | High | Written staff consent with versioned notice, duty-only tracking enforced server and client side, retention TTL, counsel review checklist (§7), microfinance blocked behind legal sign-off. |
| R-6 | Staff fraud (fake visits, pocketed cash, mock GPS, backdated entries). | Medium | High | Camera-only photos, mock detection, clock skew, distance-to-pin, SMS receipt (proposed), cash limits and deposit verification, anomaly flags in inbox. |
| R-7 | Low-end devices (2 GB RAM, Android 8–10) and weak 2G/3G networks. | High | Medium | Paginated lists, delta sync, gzip, image compression to ≤ 250 KB, SQLite local DB, no heavy animations, cold-start budget. |
| R-8 | Scale to ~100 staff (location volume ~100k points/day). | Medium | Medium | Mongo time-series collection, batch ingest, TTL, aggregates; capacity numbers in 06-data-model §9. |
| R-9 | Single maintainer on Laravel side; slow answers. | High | Medium | ERP studied and API prototyped on a sandbox copy (erp-findings.md, erp-integration-spec v2); spec written to reconcile with their guidelines. |
| R-10 | Tile provider limits/terms (OSM's public tiles forbid heavy app use). | High | Medium | Swappable `TileProvider`; never ship with `tile.openstreetmap.org` as production provider; cache headers respected. |
| R-11 | Feature-flag sprawl and module coupling over time. | Medium | Medium | Manifest + boundary lint + flag registry with owner and expiry date. |

### 6.4 Legal / compliance checklist for counsel (not legal advice)
1. Employee location tracking during duty hours: written consent, notice wording (Bangla), labour-law fit. 
2. Bangladesh personal-data protection legislation status and obligations (consent, purpose limitation, retention, cross-border storage if Atlas/S3 region is outside Bangladesh).
3. Photographing customers/premises: consent wording; policy that photos show the door/premises, not people, unless needed.
4. SMS to customers (proposed): sender ID registration and content rules.
5. Microfinance: Microcredit Regulatory Authority (MRA) licensing and separation from the showroom business **before any implementation**.
6. Record retention period for financial records (receipts/collections) — default 8 years for collections (Open decision OD-09).

## 7. Scale assumptions

| Metric | Now | Design target |
|---|---|---|
| Field staff | 30 | 100 (tested to 200) |
| Customers with active plans | ~10,000 (ASSUMPTION) | 100,000 |
| Collections / day | ~600 | 3,000 |
| Visits / day | ~900 | 4,000 |
| Location points / staff / day | — | ~1,200 (9 h duty, adaptive) |
| Location points / day | — | 120,000 |
| Photos / day | ~900 | 4,000 (≤ 250 KB each → ~1 GB/day) |
| Web users | 2 | 15 |

## 8. field-api's role (this repo)

`field-api` is the **hub**: the only writer of field data, the only client of Laravel, the owner of the API contract (`docs/openapi.yaml`), RBAC, audit, feature flags, background jobs, notifications and reports. Its design goals:

1. Never lose or double-count a field payment.
2. Never block field work because Laravel is down.
3. Make every sensitive change traceable (who, when, what, before/after, why).
4. Let a new feature be added as a module without touching existing modules.

## 9. Out of scope (now)
- Microfinance implementation (boundary reserved only).
- Any change to Laravel schema or business logic.
- iOS app (Flutter keeps the door open).
- Customer-facing app or portal.
- Payment-gateway integration (bKash/Nagad API verification) — reserved as module `payment-verify` (proposed, phase 4).
