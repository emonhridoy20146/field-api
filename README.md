# field-api

Backend for the Howlader Electronics **Field Operations System**: field collections with offline sync, visits, notes, promises, attendance, duty-hour location, assignments, handovers, RBAC, audit, notifications and reports. Integrates with the existing Laravel ERP (source of truth for money) through versioned integration endpoints.

- Stack: Node.js 22, TypeScript, Fastify 5, Mongoose 8, MongoDB Atlas, S3-compatible storage, Firebase Cloud Messaging.
- API: `/api/v1`, contract in [`docs/openapi.yaml`](docs/openapi.yaml).
- Consumers: `admin-web` (Next.js) and `staff-app` (Flutter).

## Run locally
```bash
pnpm install
cp .env.example .env            # fill values locally; never commit .env
docker compose up -d            # mongo (replica set), minio (S3), mock-erp
pnpm db:migrate
pnpm seed:dev                   # branches, users (SA/BM/FS), sample customers from fixtures, flags ON
pnpm dev                        # API on http://localhost:4000 (PROCESS_ROLE=api)
pnpm dev:worker                 # jobs + outbox (PROCESS_ROLE=worker)
pnpm mock:api                   # Prism mock of openapi.yaml on :4010 for client developers
```
Tests: `pnpm test` (unit + integration), `pnpm test:contract`, `pnpm test:load` (k6, staging only).

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
