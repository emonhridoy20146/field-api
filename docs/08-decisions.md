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

### ADR-027 Sync mutations are declared by the owning module · accepted (2026-11-15)
`POST /sync/push` does not import business modules. Each module lists its offline mutation kinds in `syncMutations` in its manifest (entity, permission, `apply`), validating with the same zod schema as its REST route. The sync module checks the module flag and the permission, wraps every item in the idempotency store keyed by `(userId, mutationId)`, and reports per-item results. Reason: keeps module boundaries (CLAUDE.md §2.5) and makes a new offline entity a one-file change. Bootstrap snapshots only entities that declare `snapshot`: customers, plus (since 1.9.1) the working state a reinstalled app needs today: today's attendance day, visits and co-work sessions, open promises and pending pin proposals. Older history is read online; later changes arrive through pull.

### ADR-028 Reports aggregate at request time; only overdue history is stored · accepted (2026-11-16)
Staff performance, collection trends and reconciliation are computed from the source collections (indexed by business date) when asked, so a report always equals a raw query over the same period and there is no second copy to drift. The one thing that cannot be recomputed later is yesterday's overdue picture, so `overdue_snapshots` is written nightly per branch. `daily_metrics` (06-data-model §7) is deferred until a measured report is too slow; adding it later changes no API. Exports are built by a worker job with the requester's *current* scope, in CSV and a small owned XLSX writer (one flat sheet does not justify a spreadsheet dependency).

### ADR-029 Co-work: every participant gets visit credit, money is never shared · accepted (2026-11-16)
The owner asked that two or more staff can work together and that statistics, targets and performance reflect it properly. A joint visit stays **one record by the person who recorded it**, with the partners stored on it (`coWork.participantIds`, decided by the server from the session members accepted at `checkInAt`). Reports show single and co-work visits separately. For targets, each participant is credited `soloVisits + coWorkVisits × cowork.visitCredit`; the weight is a setting (0 to 1, default 1, per-branch override) so the business can later decide that a shared visit is worth less than a single one without a code change. The same stop recorded by two members of one session counts once per person. **Collections and cash are not split or shared**: the person who took the money recorded it, carries it and deposits it, so cash accountability (FR-CASH-*) and the ERP posting stay with one collector. Requests are online only (an invitation needs the other person's answer); visits work offline because participants are resolved from stored accept and leave times when the visit arrives.

### ADR-030 Daily targets as dated records; server-side Bangla PDF with HarfBuzz · accepted (2026-11-17, owner request)
**Targets.** The owner asked for daily targets. A target is never edited in place: every change (branch default, personal target, "back to the branch default") is a new `staff_targets` record with an `effectiveFrom` of today or later, and the value of a day is the latest record in force on that day (on the same day the later `setAt` wins). A personal record beats the branch default; a `cleared` record hands the person back to the default. Weekly off, holidays and approved leave have no target. So a report for a past period always shows the target that applied then, managers can plan ahead (next month's default), and the history doubles as the audit trail. Achievement is measured against the target **up to today** in a running period, not against the whole month, so the middle of the month does not look like failure. Co-work visits count with `cowork.visitCredit` (ADR-029). Targets are a planning aid only; they never block or change a collection.

**PDF.** Bangla needs a shaping engine for conjuncts (e.g. ক্ষ, স্ট্র, র্ক). fontkit was tried and shapes Bengali wrongly; a headless Chromium would add a 300 MB browser to the worker image. The export worker therefore shapes text with HarfBuzz compiled to WebAssembly (`harfbuzzjs`, no native build) and writes the PDF itself: Type0/CIDFontType2 fonts with Identity-H, the Noto Sans Bengali and Noto Sans subsets embedded (SIL OFL, `assets/fonts/`), each text item wrapped in `ActualText` so copy and search give the real Bangla text. A4 landscape, header repeated on every page, at most 10,000 rows. HarfBuzz is imported lazily, so the API process never loads it.

### ADR-031 Map pins: managers set directly, staff pins for pinless customers apply at once · accepted (2026-11-17, owner request)
The owner asked that admins and staff can set a customer's coordinates by dropping a pin on a map, the way a ride app picks a pick-up point, mainly for customers that have no coordinates, and that staff can add pins too. Until now a pin could only come from a staff member standing at the customer (GPS ≤ 30 m) and a manager had to approve it. Decisions: (1) a manager with `customer.location.approve` may set a pin directly (`POST /customers/{id}/location`); it is stored as an already-approved `location_proposals` record with `direct: true`, so pin history, the customer timeline and the "approved" list need no new collection. (2) Staff proposals gain `method: map` (point picked on the map, not held to GPS accuracy) and `deviceGeo` (where the phone was) so the reviewer sees the distance. (3) **Owner decision on the card 2026-11-17:** a staff pin for a customer without a usable pin (`missing`, `invalid`, `suspect_swapped`) is applied at once; moving an existing pin still waits for a manager. It is the per-branch setting `customers.staffPinApproval` (`when_missing` default, `always` to review every pin); a mock phone position never applies at once. (4) Any applied pin (approval, auto, direct) emits `customer.placed`, so polygon areas and the primary assignee are recomputed; before 1.11.0 an approved pin waited for the next area edit. Risk accepted by the owner: a pin auto-applied from the field is not reviewed first; managers see it in the approved list marked "applied at once" with the phone distance, and can move it.

### ADR-032 Leave, holidays, shifts and notices finished for the screens · accepted (2026-11-17, owner request)
The owner asked for the leave, holiday calendar, shift and notice screens in the app and the admin panel (items 6 and 7 of the 2026-11-17 list) and the guarantor call button (item 8). The server already had most of it; contract 1.12.0 fills the gaps found while designing the screens, all additive. (1) **Leave cancel:** the overlap rule blocked a staff member who typed wrong dates until a manager rejected the request, so the requester may now withdraw a pending request (`cancelled`); a decided request cannot be cancelled by staff (a manager handles changes to approved leave). (2) **Holidays:** a holiday entered by mistake can be deleted (hard delete, audited with the old value), so the list now carries `id`; a second holiday on the same day for an overlapping set of branches is refused, and the scope must match the type. Days already finalised are not re-derived. (3) **My shift:** the phone did not know which shift applied to the staff member, so `GET /attendance/me/shift` resolves it the same way attendance does. (4) **Notices:** "read" is a sync mutation (`broadcast_ack`) so it works offline like everything else in the app; the time kept is the phone's tap time, clamped between sending and receipt so a wrong phone clock cannot claim an earlier read. Managers see who has and has not read a notice (not read first) to follow up. (5) **Guarantor calls** are logged as contact attempts with `target: guarantor`; the guarantor's number is never stored in the log.

### ADR-033 A FOS plan is an ERP invoice; field-api follows the real ERP rules · accepted (2026-11-18, owner request)
The owner asked to align the three apps with the real Laravel ERP without changing the ERP, which is in production, and to document it so the ERP API can be added later. The ERP was read and its data loaded into a private sandbox copy; the field API was written there as additive files and tested against the real data (erp-findings.md, erp-integration-spec v2). Decisions: (1) **Plan = invoice.** The ERP records payments against `sales_invoices` (installment or credit sale), one installment plan per installment invoice, so `erpPlanId` is the invoice id and the ERP plan id is kept as `erpInstallmentPlanId`. A credit sale is a plan with one line on its due date. (2) **Outstanding = the invoice's `amount_due`**, the number the ERP's own payment form checks; the stored customer balance is ignored. (3) **Schedule:** line amount = due + late fee, paid from the ERP, status computed by FOS (the stored status is stale); lines the ERP's roll-forward job zeroed are kept with `rolled: true` and hidden by the apps; overdue uses the ERP report's definition (unpaid on lines due before today). (4) **Not collectable:** returned → `closed`, cancelled → `cancelled`; both are left out of totals. (5) **Posting** goes through the ERP's own `PaymentService` with every office rule: no overpayment, collector employee required (`COLLECTOR_NOT_LINKED` if the staff user is not linked), a method of that type at the branch (`METHOD_NOT_AVAILABLE`), one payment per installment invoice per day (`DUPLICATE_SAME_DAY`, OD-27), back-date window (OD-28; the owner later chose no window). (6) **Removal** in the ERP is a hard delete; the API reports it from the audit log and FOS shows the payment as reversed. (7) **Branches:** warehouses are synced too (26 customers' latest invoice is on one); branch coordinates are set in FOS. (8) The ERP repository stays untouched until the owner decides to install the prototype (spec §8); field-api runs the same code paths against the mock today.

### ADR-034 Vercel serverless for test deployments only · accepted (2026-11-18, owner request)
The owner wants to deploy and try the API before choosing the real host (OD-08). ADR-011 stays for production. For tests, `src/app/serverless.ts` caches the Mongo connection and the built app per function instance and hands each request to Fastify; `api/index.js` serves every route through a rewrite in `vercel.json`. The worker becomes `api/cron.js`, protected by `Authorization: Bearer CRON_SECRET` (constant-time compare): one call runs the jobs whose schedule matches that minute (Mongo leases, ADR-008, keep overlapping calls safe) or one named job, then drains the outbox in batches of 5 until 40 s after the call started (jobs included, so a call stays under the 60 s limit). JWT keys are required (ephemeral keys would differ per instance). **Accepted limits:** in-memory rate limits per instance, cold starts, outbox delay until the next cron call, 60 s per function, Atlas open to all IPs. Not for production money.

### ADR-035 Map pin colour = payment state; missed installments survive the ERP roll-forward · accepted (2026-11-18, owner request)
The owner asked for Google-Maps-style pins coloured by how a customer pays: red for a bad flag or a "full cycle" overdue, orange for several installments due but not a full cycle, yellow for one missed date, green for paid. **Reading chosen:** "full cycle" = the whole plan term (the ERP's "plan maturity", `SalesInvoice::finalInstallmentDueDate`): the final due date has passed and money is left — the same rule as the bad-customer suggestion (FR-TAG-001). For a credit sale the term is its one due date. "Bad flag" = a FOS tag with severity `bad` or `legal` (a `watch` tag alone does not turn a pin red). Added: blue = due today with nothing missed, grey = nothing left to pay; green = everything due so far is paid. **Missed installment:** a past-due line with money left; because the ERP's daily roll-forward job zeroes a missed line and adds its balance to the next line, a zeroed past line also counts while the line that took its balance is still unpaid (otherwise a customer who missed two months would look green until the next date). A rolled line that had been part-paid cannot be told from a paid line and is not counted. The state is computed in `customers/domain/status.ts` (`payState`, worst first) and stored as `derived.missedCount` so the list and map can filter it. Rejected: the ERP risk grade as the colour (it is a monthly-late score, not what the owner described) and a fixed number of days per colour (plan frequencies differ: daily, weekly, monthly).

### ADR-036 Deleting a pin is an overlay, and the manual ERP sync is time-boxed · accepted (2026-11-18, owner request)
The owner asked that an admin can delete any customer's map pin, and that the admin panel has a working "Sync from ERP" button. **Pin delete:** `DELETE /customers/{id}/location` sets `fos.locationOverride = { cleared: true }` and removes `location` instead of erasing data, because the ERP is the owner of its coordinates and the ERP sync rewrites `location` on every run; without the override the old pin came back at the next 5-minute sync. The ERP coordinates stay in `erpLocation`; a new pin (manager, or staff under `customers.staffPinApproval`) replaces the override. Deleting uses the permission of setting a pin (`customer.location.approve`, super admin and branch manager) and is audited as `customer.location.cleared`. Pending staff proposals stay pending. **Manual sync:** `POST /system/erp-sync` (new permission `erp.sync`) runs the delta sync with a 40 s budget because the Vercel test deploy stops a function at 60 s and no worker runs there (ADR-034): a first full pull of about 1,400 customers needs several calls, so the run saves `resume` per branch and answers `partial: true`; the button calls again. One run at a time through a Mongo lock, so a double click or two admins cannot start two pulls. The scheduled job honours the same `resume`. Rejected: one long request (times out on Vercel), per-branch sync (the ERP calls are cheap and the watermark is per branch anyway), a separate worker queue (production already has the 5-minute job).
### ADR-039 Files in MongoDB when the host has no S3 · accepted (2026-11-18, owner report)
On the Vercel test deployment (ADR-034) there was no S3, so storage was in memory: each function instance had its own files and the upload URLs were `memory://`, which no phone can PUT to. The attendance photo never uploaded, the held work-in never reached the server, and the server then refused every location point as off duty, so the live map stayed empty. **Decision:** a third storage driver `db` keeps files in the `storage_objects` collection and serves them through `PUT|GET /api/v1/storage/o?t=<grant>`. The grant (key, method, expiry, and for PUT the content type, size and sha256) is signed with an HMAC key derived from the JWT private key, which every instance shares; URLs expire after 5 minutes, like presigned S3 URLs, and the API never puts a bearer token in them. Chosen automatically on Vercel when no S3 is configured, or with `STORAGE_DRIVER=db`. **Limits:** files count against the Atlas quota (about 250 KB per photo; a free M0 cluster has 512 MB), no thumbnails, no lifecycle rules. Production keeps S3/R2 (private bucket); set `S3_*` and the driver switches back to S3. Rejected: Vercel Blob (public URLs, a second vendor) and keeping the in-memory store (broken across instances by design).
### ADR-040 Attendance is sent at once; its photo follows · accepted (2026-11-19, owner request)
Since staff-app 0.4.0 the app held an attendance event until its photo was uploaded, so the server would get the event with the photo. When the upload failed (no S3 on the Vercel test, a wrong `PUBLIC_BASE_URL`, a weak network) the event never arrived: attendance showed "waiting", the server treated the person as off duty and refused every location point (FR-LOC-001). The owner: "location coordinates must keep going every few minutes; whether the image uploads or not does not matter". **Decision:** the app sends every attendance event at once, without waiting for the photo; the server flags it `no_selfie` as before (FR-ATT-001 never rejected an event over a photo). When the photo is confirmed, the app sends the sync mutation `attendance_selfie { eventClientId, selfieMediaId }`, which links it and removes the flag. A photo already on the event is never replaced. Storage links are also built from the host the request came in on, so a wrong `PUBLIC_BASE_URL` cannot break uploads; `PUBLIC_BASE_URL` is only the fallback. `/system/health` shows the storage driver. Rejected: dropping the photo requirement (the owner still wants the photo when it works) and retrying the held event on a timer (still blocks location while the upload fails).

### ADR-037 Admin tasks for staff: a resolve request is verified by an admin · accepted (2026-11-18, owner request)
The owner asked that an admin can give any staff member a task with a note, not tied to a customer; the staff member is notified, sends a resolve request, and the task is resolved only after an admin verifies it. **Chosen:** a new module `tasks` (flag `module.tasks`, off by default) with states `open → resolve_requested → resolved`, a reject path back to `open` that needs a reason (same rule as rejecting leave), and `cancelled`. Alternatives rejected: reuse customer notes (they are tied to a customer and immutable), reuse broadcasts (no per-person state). The assignee must be an active field staff member; the branch is stored on the task (one of the assignee's branches) so manager scope works for staff in several branches. Resolve request and verify/cancel are idempotent replays, so offline retries never fail. Notifications reuse the notification center; managers also get an inbox item until the request is decided. Assignee cannot resolve alone by design: the owner wants the admin's check.

### ADR-038 Field staff see their whole branch; staff may hold several branches · accepted (2026-11-18, owner request)
The owner wants a field staff member to see every customer of their branch even when nobody assigned them, and a staff member to work in several branches (chosen when the account is made or later). **Decision:** the customer scope of `field_staff` is every customer of `user.branchIds` (like a branch manager), switchable per branch back to the old assigned-only rule by `customers.staffVisibility = assigned`. Assignment keeps its meaning (primary assignee, "my customers", Today, targets, handovers, area rules); visits to a customer that is not one's own still carry the `not_in_scope_at_record_time` flag as information. Visits, collections and promises stay "own only" for staff. `branchIds[0]` is the home branch for everything that needs one branch (attendance, cash, targets, shift, app settings). **Sync:** a customer change is written once with `fanoutBranchId` instead of one row per device; pull reads `userIds = me OR fanoutBranchId ∈ my branches`, and each entity loader still applies the caller's scope, so a device never receives a customer it may not see (it gets a tombstone instead). Branch membership and setting changes re-send the branch's customers, so devices converge without a full resync. **Rejected:** writing one change row per staff member (a staff member added later would miss earlier rows), and a hard-coded rule without a setting (a branch may want the old rule back).

**Addendum 2026-11-19 (contract 1.20.1):** on the owner's test server, phones that logged in before the server moved to 1.19.0 still showed only assigned customers: entries reach a device only when a customer changes, so nothing re-sent the rest of the branch. Fix: a generic *resync floor* in the change feed (`counters` `sync_floor:<reason>`). The customers module raises `customers-branch-wide` at its first boot on a database with history (a newly allocated seq), and `/sync/pull` answers `410 CURSOR_EXPIRED` for a cursor below it, so each such phone takes one fresh snapshot and keeps its outbox. Chosen over a data migration (the owner deploys by hand and may not run `db:migrate`) and over re-sending every customer (one snapshot per phone is cheaper than one feed entry per customer per branch). `GET /system/health` now reports `contract` so a deploy can be checked.

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
| OD-12 | Photo at attendance events | **Decided by the owner 2026-11-16:** front-camera photo required at work-in, break start, break end and work-out. Settings `attendance.selfieRequired` (default true) and `attendance.selfieEvents` (default all four), per branch | Setting |
| OD-13 | "Far from pin" radius | 300 m | Setting |
| OD-14 | Default shift and weekly off | 09:00–18:00, Friday off, late grace 15 min, max break 60 min | Settings |
| OD-15 | Staff leaderboard visible to staff | OFF. Built 2026-11-17: managers with `report.view` always see it; setting `reports.leaderboardVisibleToStaff` (per branch) lets field staff see their own branch's board and their rank | Setting |
| OD-16 | Default language | Bangla, English toggle | — |
| OD-17 | Tile provider | Self-hosted Protomaps PMTiles (BD extract); fallback MapTiler | Config only |
| OD-18 | Object storage provider | Cloudflare R2 | Config only |
| OD-19 | Address-accuracy test to decide on Google Maps | Test 200 random customers in 2 branches: if > 25 % of pins/addresses unusable on OSM base map, evaluate Google behind TileProvider | Map layer |
| OD-20 | Minimum Android version | Android 8.0 (API 26) | Device support |
| OD-21 | Promise horizon / grace | max 60 days ahead, 1 grace day | Setting |
| OD-22 | Domains | `api.<domain>`, `admin.<domain>` same parent domain (needed for SameSite cookie) | Deploy |
| OD-23 | Daily targets per staff (FR-COL-015) | **Decided by the owner 2026-11-17: build it.** Branch default plus personal targets, set by SA/BM (`target.manage`), dated from today onward (ADR-030) | Reports |
| OD-24 | Photo required for collections above an amount | Off (0) | Setting |
| OD-26 | How Bangla PDF exports are rendered (conjuncts need a shaping engine) | **Closed 2026-11-17 (owner: build the report PDFs).** The export worker shapes with HarfBuzz and embeds Noto fonts (ADR-030); no browser needed | reports/exports.ts |
| OD-25 | Bad-suggestion tolerance for tiny leftovers (e.g. 1 poisha after a plan ends) | No tolerance (rule as written) | Domain rule in customers/domain/status.ts |
| OD-27 | May a field collection land on an installment invoice that already has a payment that day? (ERP permission `installment.allow-same-day-duplicate` for the integration user) | **No**: the second one becomes a `DUPLICATE_SAME_DAY` conflict and the office decides | ERP role of the integration user; `MockErpClient.allowSameDay` |
| OD-28 | How many days back may a field collection be dated? (the office form allows 2) | **Decided by the owner 2026-11-18: any past date** ("আমার তো যেকোনো তারিখের টাকা আদায় করতে পারা উচিত"), as the office can with the back-date permission. `FIELD_API_MAX_BACKDATE_DAYS` empty = no window (a number still limits it, older → `PERIOD_LOCKED` conflict); a future date is always refused | ERP `.env` |
| OD-29 | Write staff pins back to the ERP customer coordinates? | **No** in ERP API v1; FOS keeps pins | Later ERP endpoint |

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
