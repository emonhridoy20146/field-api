# field-api

Backend for the Howlader Electronics **Field Operations System**: field collections with offline sync, visits, notes, promises, attendance, duty-hour location, assignments, handovers, RBAC, audit, notifications and reports. Integrates with the existing Laravel ERP (source of truth for money) through versioned integration endpoints.

- Stack: Node.js 22, TypeScript, Fastify 5, Mongoose 8, MongoDB Atlas, S3-compatible storage, Firebase Cloud Messaging.
- API: `/api/v1`, contract in [`docs/openapi.yaml`](docs/openapi.yaml).
- Consumers: `admin-web` (Next.js) and `staff-app` (Flutter).

## Run locally
```bash
pnpm install
cp .env.example .env            # fill values locally; never commit .env
docker compose up -d            # MongoDB (replica set) and MinIO; add `--profile erp` for the HTTP mock ERP
pnpm db:migrate
SEED_PASSWORD='choose-one' pnpm seed:dev   # branches, one user per role, sample customers, module flags ON
pnpm dev                        # API on http://localhost:4000 (PROCESS_ROLE=api)
pnpm dev:worker                 # jobs + outbox (PROCESS_ROLE=worker)
```
No Docker? `pnpm smoke` boots migrate → seed → API → worker against a throwaway in-memory MongoDB and checks sign-in.

`ERP_MODE=mock` (default) uses an in-process fake ERP. To exercise the real HTTP client, run `pnpm mock:erp` and set `ERP_MODE=live`, `ERP_BASE_URL=http://localhost:4100/api/integrations/field/v1`. Laravel itself is never touched from this repo.

## Checks (all run in CI)
| Command | What it proves |
|---|---|
| `pnpm lint` | ESLint (no `any`, injected clock only), Prettier on scripts, module boundaries (dependency-cruiser) |
| `pnpm typecheck` | strict TypeScript |
| `pnpm test` / `pnpm test:coverage` | unit + integration + contract tests on an in-memory MongoDB replica set; coverage gates |
| `pnpm check:permissions` | every route declares access; permission keys match `docs/02-requirements.md §3.1` |
| `pnpm openapi:lint` | contract is well formed; every implemented route is in `docs/openapi.yaml` |
| `pnpm check:changelog` | `src/` changes come with a `docs/CHANGELOG.md` entry |

New module: `pnpm new:module <name>`, then follow the checklist in `CLAUDE.md §5`.

## Environment variables (names only)
| Name | Purpose |
|---|---|
| `NODE_ENV` | development / staging / production |
| `PROCESS_ROLE` | `api` or `worker` |
| `PORT` | HTTP port |
| `PUBLIC_BASE_URL` | e.g. https://api.example.com |
| `ADMIN_WEB_ORIGIN` | CORS allow-origin for admin-web |
| `COOKIE_DOMAIN` | parent domain for refresh cookie |
| `MONGODB_URI` | Atlas connection string (SRV) |
| `MONGODB_DB_NAME` | database name |
| `JWT_PRIVATE_KEY` | EdDSA/ES256 private key (PEM, base64) |
| `JWT_PUBLIC_KEY` | public key |
| `JWT_KEY_ID` | key id for rotation |
| `ACCESS_TOKEN_TTL_SEC` | default 900 |
| `REFRESH_TOKEN_TTL_DAYS_APP` | default 30 |
| `REFRESH_TOKEN_TTL_HOURS_WEB` | default 12 (idle) |
| `ERP_BASE_URL` | Laravel integration base URL |
| `ERP_API_TOKEN` | Sanctum token of integration user |
| `ERP_API_TOKEN_NEXT` | next token during rotation |
| `ERP_MODE` | `live` / `record_only` / `mock` |
| `ERP_TIMEOUT_MS` | default 10000 |
| `S3_ENDPOINT` | S3-compatible endpoint |
| `S3_REGION` | region |
| `S3_BUCKET_MEDIA` | private media bucket |
| `S3_BUCKET_EXPORTS` | exports bucket |
| `S3_ACCESS_KEY_ID` | key |
| `S3_SECRET_ACCESS_KEY` | secret |
| `FCM_PROJECT_ID` | Firebase project |
| `FCM_SERVICE_ACCOUNT_JSON` | service account (base64) |
| `SMS_PROVIDER` / `SMS_API_KEY` / `SMS_SENDER_ID` | proposed SMS module |
| `SENTRY_DSN` | error tracking (optional) |
| `LOG_LEVEL` | info / debug |
| `TZ_BUSINESS` | `Asia/Dhaka` (fixed) |

## Documentation
| File | Content |
|---|---|
| [docs/01-system-analysis.md](docs/01-system-analysis.md) | Whole-system analysis, contradictions, risks |
| [docs/02-requirements.md](docs/02-requirements.md) | **Master** FR/NFR catalog + permission catalog |
| [docs/03-design-guide.md](docs/03-design-guide.md) | API style, copy, formats, status tokens |
| [docs/04-architecture.md](docs/04-architecture.md) | Modules, manifest, folder tree, flows |
| [docs/05-api-contract.md](docs/05-api-contract.md) · [docs/openapi.yaml](docs/openapi.yaml) | Contract |
| [docs/06-data-model.md](docs/06-data-model.md) | Collections, indexes, TTL, backups |
| [docs/07-test-plan.md](docs/07-test-plan.md) | Tests + traceability matrix |
| [docs/08-decisions.md](docs/08-decisions.md) | ADRs, open decisions, self-review |
| [docs/09-progress.md](docs/09-progress.md) | Roadmap + acceptance criteria |
| [docs/erp-integration-spec.md](docs/erp-integration-spec.md) | Laravel endpoints, assumptions, maintainer checklist |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | Changes |
