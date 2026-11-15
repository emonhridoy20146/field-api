# 08 — Decisions (ADR log, system-wide)

Format: **Decision · Status · Reason · Alternatives rejected · Consequences.**
Statuses: `fixed` (given by client brief, not re-opened), `accepted` (recommended by this spec), `proposed` (needs client confirmation — also listed in §3 Open decisions).
Client-repo decisions live in `admin-web/docs/08-decisions.md` (ADR-W…) and `staff-app/docs/08-decisions.md` (ADR-M…).

---

### ADR-001 Three separate repositories · fixed
- **Reason:** single-purpose repos, independent release cadence (APK vs web vs API), clear ownership for AI agents.
- **Alternatives rejected:** monorepo (Nx/Turborepo) — would simplify shared types but was explicitly ruled out.
- **Consequences:** contract sharing via `field-api/docs/openapi.yaml` + type generation; design tokens duplicated in two docs with a version number; cross-repo changes need ordered releases (field-api first, additive).

### ADR-002 Node.js + TypeScript + Mongoose; MongoDB Atlas for field data only · fixed
- **Reason:** JSON-shaped, write-heavy field data; flexible schema; time-series support for location.
- **Consequences:** money truth never in Mongo; strict TS + zod to compensate for schema flexibility; migrations still mandatory.

### ADR-003 Fastify as HTTP framework · accepted
- **Reason:** plugin encapsulation maps 1:1 to modules; schema-first validation; ~2× Express throughput; first-class TypeScript; small surface for AI agents to learn.
- **Alternatives rejected:** *Express* (no encapsulation, middleware sprawl, slower); *NestJS* (good module system but heavy decorators/DI, its own module concept would compete with our manifest, larger learning surface); *Hono* (great for edge, thinner ecosystem for Mongo/jobs).
- **Consequences:** each module exports a Fastify plugin; the manifest wraps it with feature gate and permissions.

### ADR-004 Design-first OpenAPI contract · accepted
- **Reason:** fixed decision says field-api owns `docs/openapi.yaml`; design-first lets admin-web and staff-app start against a mock server (Prism) before endpoints exist; reviews happen on the contract, not code.
- **Alternatives rejected:** *code-first generation* (zod-to-openapi) — contract would drift with implementation details and consumers could not start early; *GraphQL* — caching/offline story for mobile is more complex and not needed.
- **Consequences:** runtime validation with zod in each module; CI validates every response against openapi.yaml (conformance tests); `openapi-typescript` types for admin-web; Dart client generated or validated against examples.

### ADR-005 ERP read-model cache in field-api · accepted
- **Reason:** offline-first app needs data in its scope; Laravel must not be hammered by 100 devices; a single integration client is easier to secure and to adapt to Laravel's real schema.
- **Alternatives rejected:** *pass-through proxy* to Laravel on every request (fails when Laravel is slow/down, no offline); *apps call Laravel directly* (spreads credentials, couples apps to Laravel schema).
- **Consequences:** every value shows `erpFetchedAt`; delta sync + nightly reconcile; on-demand refresh; balances labelled "as of".

### ADR-006 field-api issues its own tokens (JWT access + rotating opaque refresh) · accepted
- **Reason:** field staff and managers are FOS users with FOS permissions; Laravel must not be modified; offline unlock needs app-side control.
- **Alternatives rejected:** *Laravel Sanctum as identity provider* (requires Laravel changes, couples availability); *Firebase Auth* (phone OTP costs, another vendor holding identities, RBAC still needed); *Keycloak* (operational overhead for 30–100 users).
- **Consequences:** password reset handled by admins (no email/SMS OTP needed initially); optional link to Laravel employee id.

### ADR-007 Custom sync protocol (mutation push + change-feed pull) · accepted
- **Reason:** only a handful of entity types, one-directional ownership (staff creates, server decides), money needs explicit idempotency and conflict semantics that generic sync engines hide.
- **Alternatives rejected:** *MongoDB Atlas Device Sync / Realm* (deprecated by MongoDB, end-of-life announced); *PowerSync / ElectricSQL* (another vendor/service, Postgres-centric); *CouchDB/PouchDB replication* (different DB, conflict model not money-safe); *Firestore offline* (second database, cost, no control over money flow).
- **Consequences:** `sync` module with `sync_changes` feed, cursors, tombstones, bootstrap; well-tested state machine on device.

### ADR-008 Mongo-backed job runner · accepted
- **Reason:** no extra infrastructure (Redis); jobs are low volume (sync every 5 min, nightly aggregates, outbox); leases in Mongo are sufficient.
- **Alternatives rejected:** *BullMQ + Redis* (better throughput, but a second stateful service to secure/back up); *OS cron* (no retries, no visibility); *Agenda* directly (maintenance concerns — keep an Agenda-compatible interface so it can be swapped).
- **Consequences:** `core/jobs` interface; worker process separate from API; job runs logged; can migrate to BullMQ if throughput demands.

### ADR-009 Background location on Android · proposed (OD-04)
- **Options:** (a) `flutter_background_geolocation` (Transistor Software) — mature motion detection, OEM workarounds, SQLite queue, HTTP batching; **paid licence for release builds**. (b) `geolocator` + own foreground service + `activity_recognition` + WorkManager — free, more code, more OEM testing.
- **Recommendation:** (a) if licence approved — it directly reduces risk R-4 (battery/OEM killing), which is the hardest problem in this project. Keep a `LocationEngine` interface in the app so (b) can replace it.
- **Consequences:** P2 starts with a 1-week spike on 4 OEM devices to confirm.

### ADR-010 Object storage: S3-compatible, private bucket, presigned URLs · accepted (provider = OD-18)
- **Reason:** fixed decision; presigned PUT avoids passing photos through the API; private bucket + short-lived GET URLs protect customer photos.
- **Provider candidates:** Cloudflare R2 (no egress fees — admins view many photos), AWS S3 ap-south-1, DigitalOcean Spaces (Bangalore). Recommendation: **R2** for cost, or S3 if the whole stack is on AWS.

### ADR-011 Deployment: one Docker image, `api` (×2) + `worker` (×1) · accepted (provider = OD-08)
- **Reason:** simple, cheap, horizontally scalable API; jobs isolated from request latency.
- **Alternatives rejected:** *serverless functions* (long-running jobs, Mongo connection churn, cold starts on weak networks); *Kubernetes* (overkill at this scale).
- **Consequences:** health/readiness endpoints, graceful shutdown, `PROCESS_ROLE`.

### ADR-012 Offline receipt numbers from per-device blocks · proposed (OD-01)
- **Reason:** staff must hand a receipt number to the customer while offline; it must be unique across devices and traceable to staff and date.
- **Format:** `{BRANCHCODE}-{STAFFCODE}-{YYMMDD}-{SEQ4}`; device requests a block (default 200) during sync; a gap report flags skipped numbers (fraud signal).
- **Alternatives rejected:** *server-issued only* (fails offline); *random UUID* (not human-friendly, not sequential for audit); *physical book only* (no digital trace) — kept as optional extra field.
- **Consequences:** Laravel's official receipt number stored after posting; customer SMS (proposed) shows both.

### ADR-013 Money as integer poisha · accepted
- **Reason:** no floating-point errors; JSON-safe up to 9×10¹⁵ poisha.
- **Consequences:** ERP mapper converts decimal strings; UI formats.

### ADR-014 Swappable map tile provider · accepted (provider = OD-17)
- **Reason:** fixed decision (OSM + Leaflet, swappable); the public `tile.openstreetmap.org` usage policy forbids heavy app use, so production needs a provider.
- **Design:** `TileProvider { id, urlTemplate, attribution, maxZoom, subdomains, apiKeyRef }` delivered by `/meta/app-config`; admin uses Leaflet, app uses `flutter_map` (Leaflet-equivalent for Flutter) with the same config; attribution always shown.
- **Candidates:** self-hosted **Protomaps PMTiles** Bangladesh extract on object storage (cheap, also enables offline area packs); MapTiler / Stadia / Thunderforest (managed, keyed). Google Maps only if the address-accuracy test (OD-19) proves OSM data insufficient — and then only behind the same interface.

### ADR-015 In-house feature flags · accepted
- **Reason:** needs are simple (module on/off, per branch); flags must also be sent to devices in sync; avoids another vendor.
- **Alternatives rejected:** Unleash / GrowthBook / LaunchDarkly (overkill, extra service, cost).
- **Consequences:** registry with owner and review-by date; CI warns on flags past review date.

### ADR-016 Location in a Mongo time-series collection with TTL · accepted
- **Reason:** compressed storage, efficient time-range queries, native `expireAfterSeconds` for retention.
- **Alternatives rejected:** regular collection (larger, manual TTL index fine but less compression); TimescaleDB/Postgres (second DB).
- **Consequences:** aggregates computed before expiry; `location_latest` separate for fast map.

### ADR-017 Bad-customer tag stored in FOS (overlay), optional write-back · accepted
- **Reason:** Laravel cannot be restructured; tag is a field-operations judgement.
- **Consequences:** office staff do not see it in Laravel unless E-15 write-back is added; admin export available.

### ADR-018 Field collections are never rejected for business reasons · accepted
- **Reason:** the money is physically in the staff's hand; dropping the record would hide cash.
- **Consequences:** conflict queue, inbox, notifications, resolution actions; only malformed/unauthorised/tampered requests are rejected.

### ADR-019 Search via Atlas Search (fallback: text + prefix index) · accepted
- **Reason:** Bangla and English names, phone fragments, typo tolerance; Atlas Search available on M10.
- **Consequences:** search module hides the engine; tests run on fallback implementation.

### ADR-020 Microfinance strictly separated · accepted
- **Reason:** separate business/legal entity; MRA regulation; different data subjects.
- **Consequences:** reserved module and permission namespace; separate collections prefix `mf_` and preferably separate database; cannot be enabled without legal flag.

### ADR-021 Time: store UTC, compute business dates in Asia/Dhaka (Luxon), injectable clock · accepted
- **Reason:** "today" rules (overdue, due today, promises, attendance) must not shift at UTC midnight (06:00 Dhaka).

### ADR-022 Scope-based 404 for out-of-scope resources · accepted
- **Reason:** avoid leaking existence of customers in other branches.

### ADR-023 Audit log append-only with hash chain · accepted
- **Reason:** tamper evidence for money and permission changes; DB role restricted to insert/find.

---

### ADR-024 Change feed lives in core · accepted
`sync_changes` + counters are written by `core/changefeed` so a module can record a feed entry inside its own transaction without depending on the sync module. Deviation from 04-architecture (feed owned by `sync`).

### ADR-025 FOS overlay inside `erp_customers`; assignments → customers · accepted
The FOS overlay (`fos.assigneeId/areaId/tag/openPromiseDates/locationOverride`) is a sub-document of `erp_customers` instead of a separate `customer_overlays` collection, so scope filters and list sorts stay one indexed query. `assignments` depends on `customers` (not the reverse) and pushes the computed primary assignee; customer scope for field staff is `fos.assigneeId` (replaces the materialized `assignment_scopes`). Modules declare full route paths and may register extension points (list enricher, detail contributor, timeline source, handover summary contributor) to avoid import cycles. ERP sync never overwrites `fos.*`.

### ADR-026 Background-location provider is a setting · accepted (2026-11-15, owner)
Free plugin by default; `location.trackingProvider = paid` switches the app to the paid plugin when its build includes it. The licence key ships in the app build (bound to the app id), never in settings.

## 2. Rejected or deferred scope ideas
| Idea | Decision | Reason |
|---|---|---|
| Real-time live tracking (WebSocket) | deferred | Brief says random checks; polling `location_latest` is enough and saves battery/cost. |
| Customer self-service app | out of scope | Not requested. |
| bKash/Nagad API verification | deferred to `payment-verify` module (P4) | Requires merchant API agreements. |
| Bluetooth thermal printer receipts | proposed P4 | Useful for customers wanting paper; hardware cost. |
| Face recognition attendance | rejected | Privacy/legal risk; selfie at work-in is sufficient. |

## 3. Open decisions (defaults chosen — please confirm)

| ID | Question | Default used in this spec | Impact if changed |
|---|---|---|---|
| OD-01 | Receipt numbering: device blocks `BRL01-FS014-261115-0007`? Keep physical receipt books too? | Device blocks + optional physical book no. | Collections module, receipt UI |
| OD-02 | Cash-on-hand limit and enforcement | 50,000 BDT per staff, `warn` mode (80 % warn, 100 % strong warning + manager alert) | Cash module setting only |
| OD-03 | Location raw-point retention | 90 days; stops 12 months; daily summaries 24 months | TTL setting |
| OD-04 | Buy the background-geolocation licence (ADR-009)? | Yes, pending budget | P2 effort ±2 weeks |
| OD-05 | Track location during lunch break? | No (paused) | Setting |
| OD-06 | SMS receipts to customers (FR-COL-012) and gateway provider | Proposed, OFF until approved | New vendor, cost per SMS |
| OD-07 | Should verified cash deposits also be posted to Laravel? | No (FOS only) | New ERP endpoint |
| OD-08 | Hosting provider & region (API + Atlas + storage) | Atlas + compute in AWS ap-south-1 (Mumbai) for latency; data-residency check by counsel | Ops only |
| OD-09 | Retention: collections/money audit 8 y, other audit 3 y, photos 3 y, notifications 90 d | as stated | Jobs/TTL |
| OD-10 | One active device per field staff | Yes, manager approves new device | Devices module |
| OD-11 | Tag approval mode for staff-set tags | OFF (staff tags apply immediately) | Setting |
| OD-12 | Selfie at work-in | OFF by default, per branch setting | Setting |
| OD-13 | "Far from pin" radius | 300 m | Setting |
| OD-14 | Default shift and weekly off | 09:00–18:00, Friday off, late grace 15 min, max break 60 min | Settings |
| OD-15 | Staff leaderboard visible to staff | OFF | Setting |
| OD-16 | Default language | Bangla, English toggle | — |
| OD-17 | Tile provider | Self-hosted Protomaps PMTiles (BD extract); fallback MapTiler | Config only |
| OD-18 | Object storage provider | Cloudflare R2 | Config only |
| OD-19 | Address-accuracy test to decide on Google Maps | Test 200 random customers in 2 branches: if > 25 % of pins/addresses unusable on OSM base map, evaluate Google behind TileProvider | Map layer |
| OD-20 | Minimum Android version | Android 8.0 (API 26) | Device support |
| OD-21 | Promise horizon / grace | max 60 days ahead, 1 grace day | Setting |
| OD-22 | Domains | `api.<domain>`, `admin.<domain>` same parent domain (needed for SameSite cookie) | Deploy |
| OD-23 | Daily targets per staff (FR-COL-015) | Proposed; set by BM monthly | Reports |
| OD-24 | Photo required for collections above an amount | Off (0) | Setting |
| OD-25 | Bad-suggestion tolerance for tiny leftovers (e.g. 1 poisha after a plan ends) | No tolerance (rule as written) | Domain rule in customers/domain/status.ts |

No question blocks the design: every item above has a working default and is isolated in a setting, a flag or a provider config.

## 4. Self-review (performed 2026-11-15)

| Check | Result |
|---|---|
| Every FR has an owning module | ✅ 138/138 (07-test-plan §8) |
| Every FR has at least one test type | ✅ 137/138; FR-MF-002 is a documentation rule verified in review |
| Every permission key defined once | ✅ 50 keys (48 grantable + 2 reserved `microfinance.*`) in 02-requirements §3.1, each declared by exactly one module; CI `check-permissions` enforces it in code |
| Every permission key used in endpoints exists in catalog | ✅ checked against 05-api-contract §2 and 04-architecture (other dotted names there are event names, which use past tense, e.g. `collection.posted`) |
| Every decision has a reason | ✅ ADR-001…023, ADR-W01…, ADR-M01… |
| Fixed decisions unchanged | ✅ none re-opened; contradictions recorded in 01-system-analysis §6.1 |
| Laravel assumptions labelled | ✅ E-01…E-26, none stated as fact |
| Microfinance reserved only | ✅ FR-MF-001/002, ADR-020 |
| Money never computed as truth in FOS | ✅ balances from ERP; cash-on-hand is field cash, not ERP balance |
