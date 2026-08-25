# Deployment

Target stack: **Vercel** (frontend/API) + **Neon** (PostgreSQL) + **Cloudflare
R2** (private object storage). Everything in this repo also runs entirely
locally with Docker Compose (Postgres + MinIO) — see the README for the
local path, which does not require any of the accounts below.

Nothing in this section was exercised against real Neon/Vercel/R2 accounts
during this build (no credentials were available) — the app was built and
tested against local Postgres/MinIO instead, per the instruction to keep
moving locally when cloud credentials aren't available. Treat the steps
below as the documented, reviewed procedure, not as something already
verified end-to-end against production infrastructure.

## Environments

Use four separate environments, never sharing a database or bucket:

```
development   local machine (docker-compose Postgres/MinIO, or native
              Postgres.app/Homebrew + MinIO as this build used)
test          a separate Postgres database + bucket, used only by
              `pnpm test:integration` / CI — never touched by a human
preview       Vercel preview deployments, a separate Neon branch/database
              and a separate R2 bucket (or bucket prefix) from production
production    the real thing
```

## 1. Neon (PostgreSQL)

1. Create a Neon project. Create a branch per environment you need
   (`main` for production, a long-lived `preview` branch is optional — Neon
   preview branches per-PR are also a reasonable choice if you wire up their
   GitHub integration).
2. Copy the pooled connection string into `DATABASE_URL` and the direct
   (unpooled) connection string into `DIRECT_URL` for that environment
   (Prisma Migrate should run against `DIRECT_URL`; the app runtime uses
   `DATABASE_URL`).
3. Run migrations **deliberately**, never automatically from a local machine
   against production:
   ```bash
   DATABASE_URL="<neon-direct-url>" npx prisma migrate deploy
   ```
   Do this from CI (a manual-approval deploy job) or a controlled operator
   shell — never as a side effect of `next build`.

## 2. Cloudflare R2 (private object storage)

1. Create a bucket per environment (or a clearly separated key prefix if
   one bucket is preferred) — e.g. `arachnet-evidence-prod`,
   `arachnet-evidence-preview`.
2. **Do not** enable public access on the bucket. Arachnet only ever reads
   evidence through short-lived signed URLs issued by
   `storage/s3-storage.ts` after an authorization check — a public bucket
   would bypass that entirely.
3. Create an R2 API token scoped to that bucket; set:
   ```
   S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
   S3_REGION=auto
   S3_ACCESS_KEY_ID=<r2-access-key-id>
   S3_SECRET_ACCESS_KEY=<r2-secret-access-key>
   S3_BUCKET_PRIVATE=<bucket-name>
   S3_FORCE_PATH_STYLE=false
   ```
   (R2 is S3-compatible; `storage/s3-storage.ts` doesn't need any
   R2-specific code — only these env values differ from the local MinIO
   setup, where `S3_FORCE_PATH_STYLE=true` is required instead.)

## 3. Vercel

1. Import the repository as a Vercel project.
2. Set environment variables per Vercel environment (Development/Preview/
   Production) matching `.env.example`'s keys — `AUTH_SECRET` must be a
   fresh random value per environment (never reused across environments,
   never committed), `APP_URL` must match that environment's actual URL,
   `ROBOT_AUTH_PEPPER` similarly fresh per environment.
3. Preview deployments should point at a non-production Neon branch and a
   non-production R2 bucket — never let a preview deployment read/write
   production data.
4. Production deployment requires explicit human approval (a manual
   "Promote to Production" click, or an equivalent required-reviewer gate in
   your CI/CD config) — this repo's GitHub Actions workflow
   (`.github/workflows/ci.yml`) runs install/lint/typecheck/unit/integration/
   build/Playwright-smoke on every push and PR, but does not itself deploy;
   wire up Vercel's own Git integration or a separate deploy workflow with a
   required manual approval step for production.

## 4. Secrets hygiene

- Never print production secrets in CI logs or command output.
- `AUTH_SECRET` and `ROBOT_AUTH_PEPPER` must be generated fresh per
  environment (e.g. `openssl rand -hex 32`), not copied from `.env.example`
  or from development.
- Rotate a robot's device secret (`POST /api/robots/:id/rotate-secret`)
  rather than reusing one across environments.

## 5. Health/readiness

`GET /api/health` and `GET /api/ready` exist for platform health checks —
point Vercel's (or any external) monitoring at these rather than a page
route, since a page route's response time includes React rendering that
isn't representative of backend health.

## If cloud credentials aren't available

This is exactly the situation this build was completed under. Everything
was built and tested against local Postgres (Homebrew, since Docker itself
wasn't available in this sandbox — see `docs/operations.md`) and local
MinIO. `docker-compose.yml` is written and reviewed for the documented
standard path (Postgres 16 + MinIO) even though it wasn't exercised in this
particular sandbox; it should work unmodified on a machine with Docker
installed. Do not block further feature work on obtaining cloud credentials
— finish and test locally first.
