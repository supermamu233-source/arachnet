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

### 2026-08-25 (continued) — Phases 4/5/6b/7/8 complete; MVP feature-complete

Three more subagents were launched in parallel (counts+offline queue,
product intake, imports/exports) alongside the still-running robot agent.
All three were **terminated mid-task by the platform's account-wide session
usage limit** (not a bug in their work) after making substantial progress —
robots finished cleanly first. Rather than re-launch subagents (same limit
would likely recur), the primary session inspected each partial file set
directly, confirmed everything present compiled/passed, and finished the
remaining gaps itself:

- **Verified and merged** the interrupted agents' completed backend work:
  `server/services/counts.ts` + `/api/count-sessions` + `/api/counts`,
  `lib/offline-queue.ts` (Dexie/IndexedDB state machine) + `lib/client-hashing.ts`,
  `server/services/intakes.ts` + `/api/product-intakes/**` + the intake
  wizard UI, and `domain/imports/**` (the `InventorySourceAdapter` interface
  + Manual/CSV/XLSX/GenericRest implementations) + `server/services/imports.ts`.
- **Fixed two real bugs found while writing the missing tests**:
  (1) an offline-queue unit test committed all 250 filler records instead of
  one, because `syncQueuedCounts` correctly processes every eligible record
  (test bug, not implementation); (2) `domain/imports/sheet-parsing.ts`'s
  custom Spanish "cantidad ausente o no numérica" validation message was
  unreachable — a `NaN` quantity failed Zod's own base type check before any
  `.refine()` ran, leaking a generic English message into an otherwise
  all-Spanish error report.
- **Built directly** (Phase 4/5/6b/7/8 completion): imports API routes + UI
  (`/imports`), the intake review/approve UI (`/products/intakes/[id]`,
  previously unreachable from any page), the full inventory/counts UI
  (`/inventory`, `/inventory/count` with a `BarcodeDetector`+ZXing-fallback
  scanner component, `/inventory/sessions/[id]`), and the entire Phase 8
  exports feature from scratch (`server/services/exports.ts` — the four-sheet
  ExcelJS workbook, `/exports` UI, download flow).
- **Fixed a real bug in `prisma/seed.ts`** found while manually verifying the
  robot demo end-to-end: the robot device's `upsert` had `update: {}` (a
  no-op), so re-running `pnpm db:seed` printed a fresh "secret — save now"
  that was never actually persisted, making the printed secret useless on
  any run after the first. Fixed and reverified.
- **Fixed a Base UI accessibility warning** (`Button` rendering a `Link`
  needs `nativeButton={false}`), caught by the Playwright E2E run's console
  output.

**Demo workflow verified live** (dev server + real Postgres/MinIO, not
mocked): re-seeded, ran `tools/robot-simulator/simulator.py` against the
running app with a freshly rotated robot secret, and confirmed via both the
API and the discrepancy detail page that Arachnet shows exactly
expected=82 / observed=74 / difference=-8 / severity=MEDIUM /
status=SHORTAGE, with the robot's evidence and HIGH confidence visible, and
the official expected balance never touched.

**Test counts at this checkpoint**: 63 unit + 64 integration + 4 Playwright
E2E, all passing. `pnpm typecheck` and `pnpm lint` clean repo-wide.
`pnpm build` succeeds (73 routes).

Known limitations (see final report for the full honest list): no
background job queue (imports/exports process synchronously in-request);
no real email delivery (invite/reset links are logged, not sent); E2E
coverage is the catalogue-setup flow only, not the full 14-step demo script
from section 17 (that flow was instead verified manually via API + the
robot simulator, described above, rather than automated as Playwright
steps); rate limiting has an integration point but nothing wired up.

Exact next action: extend Playwright E2E coverage to the remaining steps
(count submission, discrepancy resolve, product intake approval, export
download) as a dedicated follow-up; consider a real background job runner
for imports/exports before this goes anywhere near production file sizes.
