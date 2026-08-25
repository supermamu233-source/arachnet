# Testing

## Layers

```
tests/unit/          Vitest, no I/O. Pure domain/business-rule functions
                      (domain/**). Run: pnpm test
tests/integration/    Vitest against the REAL local Postgres (arachnet_test)
                      and REAL local MinIO (arachnet-evidence-test bucket) —
                      no mocking Prisma or S3. Run: pnpm test:integration
tests/e2e/            Playwright against a running dev server. Run:
                      pnpm test:e2e
```

Nothing in `tests/integration` mocks the database or object storage — the
point of that layer is to catch exactly the class of bug a mock would hide
(a real unique-constraint violation, a real signed-URL expiry, a real image
that fails to decode).

## Running tests

```bash
# Unit — fast, no external services needed
pnpm test

# Integration — needs Postgres + MinIO running locally, and the test
# database migrated (safe/idempotent, only applies existing migrations):
dotenv -e .env.test -- npx prisma migrate deploy
pnpm test:integration

# End-to-end — needs the dev server running (pnpm dev) against arachnet_dev
pnpm test:e2e
```

## What's covered where

- **EAN/SKU rules** (`domain/products/ean.ts`, `matching.ts`) —
  `tests/unit/ean.test.ts`, `tests/unit/matching.test.ts`. Includes the
  explicit "does not match on a character-confusable near-miss (O vs 0)"
  case from product principle 2.3.
- **Quantity calculation** (`domain/inventory/quantity.ts`) —
  `tests/unit/quantity.test.ts`, including the exact robot-integration seed
  case (12 boxes × 6/box + 2 loose = 74).
- **Confidence/severity/discrepancy-status classification**
  (`domain/reconciliation/*`) — `tests/unit/reconciliation.test.ts`,
  including the seed case's severity (-8 vs. expected 82 → `MEDIUM`, since
  the absolute-unit threshold is more sensitive here than the percentage
  one).
- **Evidence pipeline** — `tests/integration/evidence.test.ts`: full
  presign→real-PUT→finalize happy path (verifies the derived DISPLAY/THUMB
  objects actually exist in MinIO), rejection of an undecodable/non-image
  upload, rejection of an oversized upload, cross-organization rejection,
  and "finalize before anything was uploaded" rejection.
- **Robot ingestion** — `tests/integration/robots.test.ts`: the full
  required matrix (accept → replay is a no-op → same-event-different-data
  is `409` → unknown robot is `401` → disabled robot is `403` → missing
  evidence is `422` → a later matching observation resolves the
  discrepancy → the expected balance itself is never mutated).
- **Tenant isolation** — every service scopes every query by the caller's
  `organizationId`; cross-tenant read/write attempts are covered alongside
  the feature they belong to (e.g. evidence's cross-org finalize rejection)
  rather than in one giant isolation-only suite, since the enforcement point
  (`assertSameOrganization`) is identical everywhere.

See `chatgpt.md` for the exact, dated pass/fail counts as of the last time
each suite was run — this file describes strategy and stays accurate even
as new tests are added; `chatgpt.md` is the point-in-time record.

## Required end-to-end demo flow (Playwright, `tests/e2e/`)

Login → create warehouse → create location → create product → assign
product to location → import expected quantity → submit a physical count →
view the resulting discrepancy → resolve it → add an unknown product through
intake → approve the intake → run the robot simulator → see the robot's
discrepancy in the UI → export an Excel workbook. See `chatgpt.md` for which
of these steps have a Playwright test today versus are still planned.

## Style

- No mocking Prisma or S3 in integration tests — use the real local services.
- Every non-trivial business rule gets a unit test before (or immediately
  after) the service that calls it is written.
- Test fixtures create their own Organization/User/Membership/Warehouse/etc.
  directly via Prisma in `beforeAll`/`beforeEach` (see
  `tests/integration/helpers.ts`) rather than depending on
  `prisma/seed.ts`'s demo data, so integration tests don't silently depend on
  the dev seed being present/unchanged in `arachnet_test`.
