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
pnpm seed:dev                   # branches, one user per role, sample customers, module flags ON (password = SEED_PASSWORD in .env)
pnpm dev                        # API on http://localhost:4000 (PROCESS_ROLE=api)
pnpm dev:worker                 # jobs + outbox, in a second terminal (`--worker` flag; works in Windows cmd/PowerShell too)
```
`pnpm dev`, `dev:worker`, `db:migrate` and `seed:dev` read `.env` (`--env-file`), so create it first.
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

**Hosting.** Production needs two long-running processes from the same image: the API and one worker (scheduled jobs and the outbox that posts collections to the ERP every few seconds). Use a container host (Railway, Render, Fly.io, a VPS with Docker). Vercel is for testing only (next section). Put the API and admin-web under one parent domain (for example `api.example.com` and `admin.example.com`): the web refresh cookie is `SameSite=Strict`, so admin on `*.vercel.app` with the API on another host signs out on every reload.
6. In admin: create the staff users and link each to their ERP employee (the ERP needs a collector on every payment), set each branch's map point, and compare a few customers' balances with the ERP.
7. Switch posting on: `ERP_MODE=live` and restart both processes. Collections that waited are sent to the ERP by the worker within about 20 minutes.

## Test deployment on Vercel (not for production)
Vercel runs the API as a serverless function (`api/index.js` → `src/app/serverless.ts`) and the worker as a function you call (`api/cron.js`), ADR-034. Good for trying the API with real phones and admin-web; not for real money.

1. MongoDB Atlas cluster (any tier); in Network Access allow `0.0.0.0/0` (Vercel has no fixed IPs; test data only).
2. `pnpm keys:jwt` and keep the three lines it prints.
3. Point a local `.env` at the Atlas test database, then run `pnpm db:migrate` and `pnpm seed:dev` (mock ERP data, one user per role, password = `SEED_PASSWORD`), or `pnpm build && node dist/src/cli.js create-admin …` for an empty start.
4. Import the repo in Vercel (root = `field-api`); `vercel.json` sets the build, the Mumbai region (`bom1`) and the routes. Environment variables:
   `NODE_ENV=staging`, `MONGODB_URI`, `MONGODB_DB_NAME`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_KEY_ID`, `ERP_MODE=mock` (or `record_only` + `ERP_BASE_URL`/`ERP_API_TOKEN`), `TRUST_PROXY=true`, `PUBLIC_BASE_URL=https://<project>.vercel.app`, `ADMIN_WEB_ORIGIN=<admin-web URL>`, `CRON_SECRET` (≥ 16 random characters). Without S3 settings, photos and exports are kept in MongoDB behind signed URLs (`STORAGE_DRIVER=db`, chosen automatically on Vercel, ADR-039): this counts against the Atlas quota (about 250 KB per photo; M0 has 512 MB). For longer tests set the S3 values (for example a free Cloudflare R2 bucket) and storage switches to S3. Set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY` and `CLOUDINARY_API_SECRET` (optional `CLOUDINARY_FOLDER`) and photos move to Cloudinary after upload (ADR-050): the MongoDB/S3 copy is removed once the copy is done; `/system/health` then shows `cloudStorage: cloudinary`.
5. Check: `curl https://<project>.vercel.app/api/v1/system/health`.
6. Worker: `curl -H "Authorization: Bearer $CRON_SECRET" https://<project>.vercel.app/api/cron` runs the jobs that are due (a slot missed since the last call still runs once, 1.45.0) and drains the outbox; add `?job=erp.delta-sync` (or any job name) to run one job now. See "Automatic ERP sync" below: without regular calls nothing syncs.

### Automatic ERP sync (nobody logged in), 1.45.0
On Vercel the worker runs only when something calls `/api/cron`: ERP customer sync (`erp.delta-sync`, every 2 minutes), collections to the ERP (outbox), attendance auto-close, stuck-collection requeue and photo copies to Cloudinary all wait for that call. admin-web's "Sync from ERP" only runs while an admin has a page open. Owner steps:
1. **Vercel** → Project → Settings → Environment Variables: set `CRON_SECRET` (at least 16 random characters, e.g. `openssl rand -hex 24`) for Production, then redeploy.
2. **GitHub** → this repository → Settings → Secrets and variables → Actions → New repository secret: name `CRON_SECRET`, the same value. `.github/workflows/cron.yml` then calls `https://howlader-apps-api.vercel.app/api/cron` every 5 minutes (it skips with a notice while the secret is missing). Check it under Actions → cron → Run workflow. Scheduled workflows run only from the default branch (after this is merged).
3. **Recommended:** GitHub runs schedules at most every 5 minutes and often 5–20 minutes late. Add a free external pinger as well, e.g. cron-job.org: URL `https://howlader-apps-api.vercel.app/api/cron`, every 1 or 2 minutes, request header `Authorization: Bearer <CRON_SECRET>`, timeout 60 s. Extra or overlapping calls are safe: jobs are leased in MongoDB and each schedule slot runs once.
Each call stays under 60 s: jobs get the call's 40 s budget (the ERP sync stops early and continues on the next call), the outbox keeps 8 s, a job that would start with less than 2 s left waits for the next call, and the nightly reconcile runs last. A call answers `{ "ran": [...], "outbox": {...} }`.

Limits of the test setup: rate limits are counted per function instance, the first request after idle is slow (cold start), events in the outbox wait until the next `/api/cron` call, and a function stops after 60 s.

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
| `ADMIN_WEB_ORIGIN` | CORS allow-origin for admin-web (comma-separated; exact origin, e.g. `https://howlader-apps-admin.vercel.app`, no trailing slash) |
| `COOKIE_DOMAIN` | parent domain for refresh cookie |
| `MONGODB_URI` | Atlas connection string (SRV) |
| `MONGODB_DB_NAME` | database name |
| `MONGODB_MAX_POOL_SIZE` | Mongo connections per process (default 10, 1–100; ADR-063) |
| `MONGODB_MAX_IDLE_MS` | close a Mongo connection idle this long (default 60000; ADR-063) |
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
| `STORAGE_DRIVER` | `s3`, `db` (files in MongoDB, ADR-039) or `memory`; empty = automatic |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name (ADR-050); photos are copied there when name, key and secret are all set |
| `CLOUDINARY_API_KEY` | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret (secret; never logged) |
| `CLOUDINARY_FOLDER` | optional folder (public id prefix), default `fos` |
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
