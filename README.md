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

`ERP_MODE=mock` (default) uses an in-process fake ERP. To exercise the real HTTP client, run `pnpm mock:erp` and set `ERP_MODE=live`, `ERP_BASE_URL=http://localhost:4100/api/field/v1`. The real ERP serves the same API from its own module (howlader-erp `docs/field-api/README.md`).

## Go live (production)
The image (`Dockerfile`) has no dev tools, so first-run steps are in `dist/src/cli.js`.

1. In the ERP, turn on its field API (howlader-erp `docs/field-api/README.md`) and keep the printed token.
2. Make the JWT key pair once and store both values as secrets:
   ```bash
   openssl genpkey -algorithm ed25519 -out jwt.pem && openssl pkey -in jwt.pem -pubout -out jwt.pub
   base64 -w0 jwt.pem   # JWT_PRIVATE_KEY
   base64 -w0 jwt.pub   # JWT_PUBLIC_KEY
   ```
3. Set the environment (table below): `NODE_ENV=production`, MongoDB, JWT, S3, `ADMIN_WEB_ORIGIN`, `PUBLIC_BASE_URL`, and `ERP_MODE=record_only`, `ERP_BASE_URL`, `ERP_API_TOKEN`. In `record_only` everything is read from the ERP but field collections wait in FOS and are not posted.
4. Run once: `node dist/src/cli.js migrate`, then `ADMIN_PASSWORD='…' node dist/src/cli.js create-admin --phone 01XXXXXXXXX --name "Owner" --enable-modules`. It pulls the ERP branches, creates the super admin on all of them (the password must be changed at first sign-in) and switches the modules on (microfinance stays off).
5. Start the API (`PROCESS_ROLE=api`) and one worker (`PROCESS_ROLE=worker`). The worker pulls the ERP customers every 5 minutes; `GET /api/v1/system/health` shows `"erp":"ok"`.
6. In admin: create the staff users and link each to their ERP employee (the ERP needs a collector on every payment), set each branch's map point, and compare a few customers' balances with the ERP.
7. Switch posting on: `ERP_MODE=live` and restart both processes. Collections that waited are sent to the ERP by the worker within about 20 minutes.

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
| `ERP_BASE_URL` | ERP field API base, e.g. https://erp.example.com/api/field/v1 |
| `ERP_API_TOKEN` | token printed by `php artisan field-api:setup` in the ERP |
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
