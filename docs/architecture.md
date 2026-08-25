# Architecture

## Summary

Arachnet is a single modular Next.js application (App Router) — not a set of
microservices. It has three logical layers:

```
app/            Route handlers (API) and pages (UI). Auth/authz + parse + call
                a service + return a typed response. No business logic here.
domain/         Pure, DB-free business rules: EAN checksums, exact product
                matching, quantity calculation, confidence/severity
                classification. Fully unit-testable without a database.
server/         Services (transactional business logic against Prisma),
                auth/session/RBAC, and cross-cutting concerns (audit).
```

Supporting infrastructure:

```
lib/            env validation, the Prisma client (driver-adapter wired),
                typed API errors, idempotency/hashing helpers, structured
                logging.
storage/        Object storage abstraction (S3-compatible: MinIO locally,
                Cloudflare R2 in production) behind a narrow interface so the
                provider is swappable without touching service code.
prisma/         Schema, migrations, seed script.
tools/          Standalone tools outside the Next.js process (robot simulator).
```

## Frontend

- Next.js 16 App Router, React 19, TypeScript strict.
- Server Components for data-heavy pages (dashboard, product/location detail);
  client components only where interactivity is required (forms, scanners,
  the offline queue).
- Tailwind CSS v4 (CSS-first `@theme` configuration, no `tailwind.config.js`)
  with a custom Arachnet palette (dark navy primary, white/off-white
  background, green accent, grey neutrals) defined in `app/globals.css`.
- shadcn/ui component source in `components/ui/` — this install uses the
  **Base UI** primitive library (`@base-ui/react/*`), not Radix; components
  behave the same but import from a different underlying package.
- TanStack Query for client-side interactive caching (offline queue status,
  polling); most reads go through Server Components instead.
- React Hook Form + Zod for all forms.
- Default UI language is Spanish (`<html lang="es">`); English is a future
  i18n pass, not implemented in the MVP.

## Backend

- Route handlers under `app/api/**` are thin: authenticate
  (`requireAuthContext`/`requireRole` from `server/auth/session.ts`), parse
  and validate the request body with Zod, call a `server/services/*` function,
  return the typed `{ data, error, requestId }` envelope (`lib/errors.ts`).
- All business logic — validation beyond shape, transactions, audit writes,
  idempotency resolution — lives in `server/services/*`, not in route
  handlers or React components.
- Every organization-scoped query is built from the `organizationId` on the
  authenticated context, never from a client-supplied value.

## Database

- PostgreSQL is the single source of truth (product principle 2.1). Excel is
  import/export only — never a store of record.
- Prisma 7 ORM. Note the breaking change from earlier Prisma versions: the
  datasource `url` cannot live in `schema.prisma` anymore; the client is
  constructed with a driver adapter (`@prisma/adapter-pg` wrapping a `pg`
  connection) in `lib/prisma.ts`, and `prisma.config.ts` supplies the URL for
  the CLI/Migrate.
- See `docs/data-model.md` for the full entity list and key constraints.

## Auth

- better-auth (self-hostable, database-backed sessions) via
  `@better-auth/prisma-adapter`, wired to the same Prisma schema as the rest
  of the app (`User`, `Session`, `Account`, `Verification` models).
- Invite-only: public sign-up is disabled at the auth-library level
  (`disableSignUp: true`). Accounts are only created through
  `server/services/invitations.ts`, which creates the `User`/`Account` rows
  directly and then calls `auth.api.signInEmail` — deliberately bypassing the
  disabled public sign-up endpoint.
- Organizations/warehouses/roles are Arachnet's own tables (`Organization`,
  `Membership`, `Warehouse`), not a better-auth plugin — better-auth only
  owns identity and sessions.
- See `docs/security.md` for the full control list.

## Robot protocol

The Robot Scout is an authenticated machine client that submits physical
observations through the same evidence/reconciliation pipeline a human count
uses — it does not have elevated privileges or a separate data path. See
`docs/robot-protocol.md`.

## Reconciliation

Expected (external systems) vs. observed (human/robot) inventory is compared
per product-location pair by a deterministic engine in `domain/reconciliation/`
and orchestrated by `server/services/reconciliation.ts`. See
`docs/reconciliation.md`.

## Why this stack, briefly

- **Next.js App Router** — one deployable, Server Components remove a
  separate API-fetch layer for most reads, Route Handlers cover the rest.
- **Prisma** — typed queries and migrations; the new driver-adapter model in
  v7 keeps the connection string out of the schema file, which is otherwise
  unrelated to why it was chosen.
- **better-auth** — actively maintained, self-hostable, database-session
  first-class (as opposed to defaulting to JWT), with a real Prisma adapter.
- **S3-compatible storage interface** — MinIO locally costs nothing and
  behaves identically to Cloudflare R2 in production; the app never talks to
  a specific provider's SDK outside `storage/s3-storage.ts`.
