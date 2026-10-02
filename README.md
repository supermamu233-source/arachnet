# Arachnet

Physical-inventory verification and reconciliation platform for irregular SME
warehouses. PostgreSQL is the source of truth; Excel is import/export only.
Arachnet compares **expected** inventory (ERP/POS/purchasing/imports) against
**observed** physical inventory (human counts, robot observations) and
surfaces the difference as a reviewable discrepancy — it never silently
overwrites an external system.

See `docs/` for the full design (architecture, data model, API, security,
privacy, reconciliation rules, robot protocol, testing strategy, deployment,
operations) and `chatgpt.md` for the dated build log.

## Stack

Next.js 16 (App Router) · TypeScript (strict) · Tailwind CSS v4 · shadcn/ui
(Base UI primitives) · PostgreSQL · Prisma 7 · better-auth (database
sessions, invite-only) · Zod · React Hook Form · S3-compatible object storage
(MinIO locally, Cloudflare R2 in production) · Sharp · ExcelJS/SheetJS ·
Dexie (offline queue) · Vitest · Playwright.

## Local setup (clean clone)

```bash
pnpm install

# Local services: prefer Docker if you have it —
docker compose up -d
# — otherwise see docs/operations.md for the Homebrew-based equivalent this
# build actually used (no Docker in that sandbox).

cp .env.example .env
# fill in DATABASE_URL, DIRECT_URL, AUTH_SECRET, S3_*, ROBOT_AUTH_PEPPER
# (see docs/operations.md for concrete local values)

pnpm db:migrate:deploy   # or: pnpm db:migrate (interactive, for schema changes)
pnpm db:seed             # demo org/warehouse/products/robot/owner user —
                         # prints a ONE-TIME temporary password, save it
pnpm dev
```

Open http://localhost:3000 and sign in with the printed owner email/password.

## Scripts

```bash
pnpm dev                 # start the dev server
pnpm build                # production build
pnpm lint                 # ESLint
pnpm typecheck             # tsc --noEmit
pnpm test                  # unit tests (Vitest, no external services)
pnpm test:integration       # integration tests against real local Postgres/MinIO
pnpm test:e2e                # Playwright end-to-end (needs `pnpm dev` running)
pnpm db:migrate               # create + apply a new migration (dev)
pnpm db:migrate:deploy          # apply existing migrations only (CI/prod-safe)
pnpm db:seed                     # (re-)seed demo data, idempotent
pnpm robot:simulate                # run the Python robot simulator
```

## Repository layout

```
app/            Route handlers (API) and pages (UI) — thin, no business logic
domain/         Pure business rules (EAN checksum, matching, quantity calc,
                confidence/severity classification) — unit-tested in isolation
server/         Services (transactional logic), auth/session/RBAC, audit
lib/            env validation, Prisma client, typed errors, idempotency,
                hashing, logging
storage/        Object storage abstraction (S3-compatible)
prisma/         Schema, migrations, seed script
tools/          Standalone tools outside the Next.js process (robot simulator)
tests/          unit/, integration/, e2e/
docs/           Architecture, data model, API, security, privacy,
                reconciliation, robot protocol, testing, deployment, operations
```

## Deployment

Vercel + Neon (PostgreSQL) + Cloudflare R2. See `docs/deployment.md` for the
exact steps — production deployment requires explicit human approval, and no
cloud credentials were available while building this MVP, so those steps are
reviewed but not yet exercised against real infrastructure.
# arachnet
# arachnet
