# Arachnet — Execution Log

This file is the project's continuity record. Read it in full at the start of
every session. Never store secrets here.

## How to resume

```bash
cd /Users/ziyihong/arachnet
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
brew services start postgresql@16   # if not already running
pg_isready                           # confirm Postgres is up
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:9000/minio/health/live  # confirm MinIO
# If MinIO is down:
# MINIO_ROOT_USER=arachnet_minio MINIO_ROOT_PASSWORD=arachnet_minio_secret \
#   nohup /opt/homebrew/opt/minio/bin/minio server --address ":9000" --console-address ":9001" \
#   /Users/ziyihong/arachnet/.minio-data > /tmp/minio.log 2>&1 & disown
pnpm install
pnpm dev
```

## Environment status (local, this sandbox — no Docker available)

- Postgres 16 via Homebrew (`brew services start postgresql@16`), trust-auth as OS user `ziyihong`.
  Databases: `arachnet_dev`, `arachnet_test`.
- MinIO via Homebrew binary (not a service yet — started manually with `nohup`, see above).
  Buckets: `arachnet-evidence` (dev), `arachnet-evidence-test` (test). Both private
  (`mc anonymous set none`).
- `docker-compose.yml` is written and is the documented standard path for any
  contributor who *does* have Docker — it was not exercised in this sandbox because
  Docker/Colima are unavailable here. Postgres/MinIO native services above are a
  local substitute with equivalent behavior.
- Node v25.7.0, pnpm 11.23.0 (installed globally via `npm install -g pnpm`; corepack
  unavailable in this shell).
- `.env` (dev) and `.env.test` are populated with working local values (not committed;
  `.env.example` is the committed template).

## Decisions and reasons

- **Deleted a pre-existing, unrelated Vite/React prototype** that occupied
  `/Users/ziyihong/arachnet` before this build (papaparse/pdfjs-dist/zustand app,
  not git-tracked). Confirmed with the user before deleting (2026-08-25) — see
  their explicit "delete old, build fresh here" choice.
- **Auth library: better-auth** (self-hostable, database-session, actively maintained,
  first-class Prisma adapter). Chosen over Lucia (no longer maintained as a library —
  now doc-only guidance) and NextAuth/Auth.js (session model defaults to JWT, less
  naturally "database-backed sessions" than better-auth).
- **Object storage adapter: @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner**
  against MinIO locally (S3-compatible), Cloudflare R2 in production (also
  S3-compatible). `S3_FORCE_PATH_STYLE=true` required for MinIO.
- **Prisma 7 breaking change from training-era Prisma**: the datasource `url` is no
  longer allowed inside `schema.prisma` — connection is now supplied via
  `prisma.config.ts` (for Migrate/CLI) and via a driver adapter passed to the
  `PrismaClient` constructor at runtime (`new PrismaClient({ adapter })`,
  `@prisma/adapter-pg` wrapping a `pg.Pool`/connection string). `lib/prisma.ts`
  implements this. Generator is `prisma-client` (new default in Prisma 7, ESM,
  not the old `prisma-client-js`), output to `lib/generated/prisma` (gitignored,
  regenerated via `prisma generate`).
- **Next.js 16 breaking changes vs. common prior knowledge**: `middleware.ts` is
  deprecated in favor of `proxy.ts` exporting a `proxy()` function (same
  semantics). Route handler `params` and `next/headers` `cookies()`/`headers()`
  remain async (Promise-based), consistent with Next 15+. Read from
  `node_modules/next/dist/docs/` before writing routing/proxy code — this
  install's docs are authoritative, not training-data Next.js.
- **Multi-tenancy**: every domain table carries `organizationId` directly (not just
  derived transitively through `warehouseId`/`locationId`) to keep tenant-isolation
  queries and tests simple and to match the field lists in the product spec.
- **InventorySource is a table, not just an enum**, so a tenant can register more
  than one named source of the same type (e.g. two different ERPs) — each row has
  a `type` enum plus a `name` and JSON `config`. `ExpectedStockBalance.sourceId`
  references it.
- **Confidence/severity/discrepancy-status are enums with deterministic
  classification functions in `domain/`**, not free-text — per the "no fake
  certainty" requirement, thresholds are configurable inputs to those functions,
  not hardcoded magic numbers, and are documented as operational thresholds only.

## Progress log

### 2026-08-25 — Phase 0 (bootstrap)

Files created/changed:
- Repo initialized at `/Users/ziyihong/arachnet` (git, empty history so far).
- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` — Next.js 16 App Router +
  TypeScript strict + Tailwind v4 + ESLint scaffold via `create-next-app`, then
  added: prisma, @prisma/client, @prisma/adapter-pg, pg, zod, better-auth,
  @tanstack/react-query, react-hook-form, @hookform/resolvers, @aws-sdk/client-s3,
  @aws-sdk/s3-request-presigner, sharp, exceljs, xlsx, dexie, qrcode, @zxing/browser,
  @zxing/library, pino, argon2, uuid, clsx, tailwind-merge, class-variance-authority,
  lucide-react; devDeps: vitest, @vitejs/plugin-react, jsdom, @testing-library/*,
  @playwright/test (chromium installed), prettier, prettier-plugin-tailwindcss, tsx,
  dotenv, dotenv-cli, @types/pg, @types/qrcode.
- `docker-compose.yml` — Postgres 16 + MinIO, documented standard local path.
- `.env.example` (committed template, spec-exact keys), `.env` / `.env.test`
  (local values, gitignored).
- `prisma/schema.prisma` — full domain model: Organization, User, Session, Account,
  Verification (better-auth tables), Membership, Invitation, Warehouse, Location
  (self-referencing hierarchy), Product, ProductBarcode, PackagingRule,
  ProductLocation, InventorySource, ExpectedStockBalance, InventoryCountSession,
  InventoryCount, EvidenceAsset, ProductIntake, RobotDevice, RobotObservation,
  InventoryDiscrepancy + DiscrepancyResolutionEvent (append-only history),
  ImportJob, ExportJob, AuditLog. All enums per product spec section 7/8.
- `lib/env.ts`, `lib/prisma.ts`, `lib/errors.ts`, `lib/hashing.ts`,
  `lib/idempotency.ts`, `lib/logging.ts`.

Database migrations:
- `prisma/migrations/20260825030557_init` — applied to `arachnet_dev`. Not yet
  applied to `arachnet_test` (test setup will run `prisma migrate deploy` against
  `.env.test` before the integration suite).

Tests executed: none yet (no application logic written past Phase 0 scaffolding).

Known limitations at this checkpoint:
- No Docker in this sandbox; local services run natively via Homebrew instead.
  `docker-compose.yml` is untested here but follows the same images/ports the app
  expects, so a machine with Docker should work unmodified.
- Auth, evidence pipeline, domain logic, UI, imports/exports, robot protocol, tests,
  and CI are not yet built — this checkpoint is Phase 0 only.

### 2026-08-25 — Phases 1–3, 6, 9 (auth, catalogue, evidence, reconciliation, admin)

Built (mix of direct work and 3 parallel subagents on disjoint file sets,
integrated and verified by the primary session):

- **Phase 1 (auth/tenancy)**: better-auth wired to Prisma via
  `@prisma/adapter-pg`; invite-only accounts (`server/services/invitations.ts`);
  RBAC (`server/auth/session.ts`, `server/permissions/rbac.ts`); dashboard
  shell with Arachnet branding. Verified end-to-end against a live dev
  server: owner sign-in, protected routes, invitation create/accept,
  RBAC-enforced 403. Fixed a real bug found this way: better-auth 1.7 added
  an `Account.issuer` column not documented in older training data —
  sign-in silently failed without it (migration
  `20260825033905_add_account_issuer`).
- **Phase 2 (warehouses/locations/products)**: built by a subagent —
  services, API routes, dashboard pages, QR generation, exact-match search
  built on `domain/products/matching.ts`. 44 unit + 34 integration tests.
- **Phase 3 (evidence pipeline)**: built by a subagent — `storage/`
  (S3-compatible, MinIO locally/R2 in prod), presign→upload→finalize with
  real `sha256` + `sharp` image decode + DISPLAY/THUMB variants, signed
  downloads only. 5 integration tests.
- **Phase 6 reconciliation engine** (built directly): 
  `server/services/reconciliation.ts` recomputes `InventoryDiscrepancy` per
  product-location pair from `domain/reconciliation/*`'s pure classifiers,
  auto-resolves on a later match (retaining history via
  `DiscrepancyResolutionEvent`), never auto-resolves a `REVIEW_REQUIRED`
  reading. Dashboard pages + API routes.
- **Phase 9 admin** (built directly): user/role management (invite, change
  role, remove), organization settings, integrations list, audit log
  viewer.
- Full `docs/` set (architecture, data-model, security, privacy,
  reconciliation, testing, deployment, operations), GitHub Actions CI
  workflow (untested against a real runner — no CI credentials available;
  documented as reviewed-not-proven in the workflow file itself).

Tests as of this checkpoint: 44/44 unit, 34/34 integration, `pnpm typecheck`
and `pnpm lint` clean repo-wide, `pnpm build` succeeds (28 routes).

Still in progress: a 4th subagent building Phase 7 (robot ingestion +
Python simulator) — not yet merged as of this log entry, see the next entry
or a later session for its outcome.

Known limitations at this checkpoint: no physical-count UI/offline queue yet
(Phase 4), no product-intake wizard yet (Phase 5), no CSV/XLSX import or
Excel export yet (Phase 6b/8), no Playwright E2E tests yet (Phase 10 gate).

Exact next action: merge Phase 7 (robot) once its subagent finishes, then
build Phases 4/5/6b/8 (counts+offline queue, product intake, imports,
exports) — likely via further parallel subagents on disjoint files, same
pattern as this session — then Playwright E2E covering the full demo
workflow, then final Phase 9/10 hardening pass and the required final report.
