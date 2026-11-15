# CLAUDE.md — field-api

Rules for AI coding agents working in this repository. Read this file fully before any change.

## 1. What this repo is
The backend of the Howlader Field Operations System: Node.js 22 + TypeScript (strict) + Fastify + Mongoose on MongoDB Atlas. It is the **only** component that talks to the Laravel ERP and the **owner of the API contract** (`docs/openapi.yaml`) consumed by `admin-web` and `staff-app`.

Read before coding: `docs/01-system-analysis.md` → `docs/02-requirements.md` → `docs/04-architecture.md` → `docs/05-api-contract.md` + `docs/openapi.yaml` → `docs/06-data-model.md` → `docs/erp-integration-spec.md`.

## 2. Hard boundaries (never violate)
1. **Money truth is Laravel.** Never compute or store an "official" balance. Cached ERP values must carry `erpFetchedAt`.
2. **Laravel is never modified** from here. Laravel field names appear only in `src/modules/erp-gateway/mappers/` and `test/fixtures/erp/`.
3. **Never drop a field collection** for business reasons — create a conflict (ADR-018).
4. **Idempotency:** every money-creating path uses the client's `idempotencyKey`; never generate a new key server-side for a client mutation.
5. **Modules:** import other modules only via `src/modules/<name>/index.ts` and only if listed in your manifest's `dependsOn`. Never import another module's `models/`, `repository`, or `service` directly. Cross-module writes go through events/outbox. `dependency-cruiser` enforces this — do not weaken its config.
6. **Permissions:** every route declares `requirePermission('<key>')` (or is explicitly self-service/public). A key is declared in exactly one manifest. Never hardcode role names in business logic — check permission keys.
7. **Scope:** every query on customer-linked data applies `scope.*Filter(user)`. Out-of-scope → 404.
8. **Time:** store UTC; compute business dates with `core/time` (Asia/Dhaka). Never use `new Date()` directly in domain code — inject the clock.
9. **Plan length is never hardcoded.** No month arithmetic for "final due date"; use ERP `finalDueDate` / max schedule date.
10. **API versioning:** `/api/v1` is additive-only. Removing/renaming fields or changing meaning needs `/api/v2` and an ADR.
11. **Microfinance:** do not implement anything under `microfinance` — reserved (FR-MF-001).
12. **Location:** never accept or store points outside duty hours.

## 3. Security rules
- No secrets in code, tests, fixtures or docs. `.env.example` lists names only. Fixtures use fake names/phones.
- Validate every input with zod; never trust client `userId`/`branchId` — derive from token and scope.
- Hash refresh tokens (sha256) and passwords (argon2id). Never log tokens, passwords, full phone numbers (mask `+88017****5678`), or photo URLs.
- Presigned URLs: PUT 5 min, GET 5 min, private bucket only.
- Audit every action listed in FR-AUD-001 via `audit.record()` inside the same transaction as the change.
- Rate limits on auth and ingest endpoints must stay.

## 4. Workflow for every change
1. Find or add the FR-ID in `docs/02-requirements.md` (new ideas start as `proposed`).
2. Contract first: update `docs/openapi.yaml` (and examples in `docs/05-api-contract.md`) before implementing. Additive only.
3. Implement in the owning module (domain → repository → service → routes).
4. Tests: unit for domain rules, integration for routes (happy, 400, 401, 403, out-of-scope 404), OpenAPI conformance, contract tests if ERP is touched.
5. Data changes: update `docs/06-data-model.md` and add a forward-only, idempotent migration.
6. **Update docs with every change:** `docs/CHANGELOG.md` (always), `docs/09-progress.md` (status), `docs/08-decisions.md` (if a decision was made), FR status in `02-requirements.md`. CI fails if `src/` changed and `docs/CHANGELOG.md` did not.
7. Run `pnpm lint && pnpm typecheck && pnpm test && pnpm check:permissions && pnpm openapi:lint` before finishing.

## 5. Module-add checklist
- [ ] `pnpm new:module <name>` (copies `templates/module/`), folder name = manifest `name`.
- [ ] Manifest: `featureFlag.default: false`, owner, description; `dependsOn`; permissions (check §3.1 catalog for duplicates; add new keys to `docs/02-requirements.md §3.1`); events (past-tense names, e.g. `thing.created`); jobs; settings with defaults; `syncEntities` if mobile needs it; `inboxTypes`/`notificationTypes`.
- [ ] `index.ts` exports only what other modules need (functions + types), nothing from `models/`.
- [ ] Routes in `docs/openapi.yaml` first; implement with zod schemas in `schemas.ts`.
- [ ] Collections/indexes/TTL in `docs/06-data-model.md` + migration in `migrations/`.
- [ ] Register in `src/app/register-modules.ts` (the only place listing modules).
- [ ] Tests: domain unit, route integration, OpenAPI conformance, permission/scope tests.
- [ ] Docs: FRs, CHANGELOG, progress, ADR if needed; tell client repos which contract version adds the routes.
- [ ] No existing module was edited except to consume a new public function/event (if you had to edit another module's internals, stop and redesign).

## 6. Testing rules
- vitest; integration tests use mongodb-memory-server in replica-set mode; no test hits real Laravel, S3 or FCM.
- Use `test/helpers/clock.ts` to freeze Dhaka time for date rules (include a test across 18:00 UTC = Dhaka midnight).
- Contract fixtures under `test/fixtures/erp/v1/…`; when the maintainer changes the API, re-record and change mappers only.
- Coverage gates: `domain/` and `mappers/` ≥ 90 %, overall ≥ 80 %.
- Never skip, disable or loosen a test to make CI pass.

## 7. Style
- TypeScript strict, no `any` (use `unknown` + zod). ESLint + Prettier defaults in repo.
- Errors: throw `AppError(code, status, details)`; codes listed in `docs/05-api-contract.md §4`.
- Money helpers from `core/money`; geo helpers from `core/geo`.
- Small files, explicit names, no clever metaprogramming. Comments explain *why*.

## 8. When unsure
Prefer asking (open a TODO in `docs/08-decisions.md §3 Open decisions` with a default) over guessing on: money rules, Laravel behaviour, privacy/tracking, permissions. Mark Laravel guesses as `ASSUMPTION E-xx` in `docs/erp-integration-spec.md §9`.
