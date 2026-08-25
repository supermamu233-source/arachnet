# Security

## Authentication

- Database-backed sessions via better-auth (`server/auth/auth.ts`), not JWT —
  a session can be revoked server-side by deleting its `Session` row.
- Session cookie is `httpOnly` by default (better-auth default), `Secure` in
  production (`advanced.useSecureCookies: env.NODE_ENV === "production"`),
  with better-auth's built-in CSRF protection left enabled (never disabled).
- Password hashing uses better-auth's built-in default (`scrypt`, via
  `@better-auth/utils/password`, Node's native `crypto.scrypt` where
  available) — this is the "auth library's secure default" allowed by
  product principle 8 as an alternative to a hand-rolled Argon2id
  integration. Minimum password length: 12 characters.
- **No public self-registration.** `emailAndPassword.disableSignUp: true` at
  the auth-library level. The only way to get an account is
  `server/services/invitations.ts::acceptInvitation`, which creates the
  `User`/`Account` rows directly (bypassing the disabled public endpoint on
  purpose) after validating a single-use, expiring invitation token.
- Password reset: `requestPasswordReset` / `resetPassword` (better-auth
  built-ins), with expiring tokens. No transactional email provider is wired
  up yet — `sendResetPassword` logs the reset link via the structured
  logger instead of sending an email (`EMAIL_PROVIDER=console` everywhere so
  far). This is a known limitation, not a design choice — see
  `docs/operations.md`.

## Authorization

- `server/permissions/rbac.ts` defines the role hierarchy (`OWNER > ADMIN >
  MANAGER > COUNTER > VIEWER`) and `roleSatisfies(actual, minimum)`.
- `server/auth/session.ts`'s `requireRole(minimum)` is the single enforcement
  point every route handler calls; it throws a typed 401/403 `ApiError`
  rather than returning an ambiguous status.
- `assertSameOrganization(context, resourceOrganizationId)` is the second
  enforcement point — every resource fetched by id is checked against the
  caller's active organization before being returned or mutated, so a
  guessed/leaked id from another tenant cannot be read. Automated tests
  assert this (`tests/integration/tenant-isolation.test.ts`).

## Robot authentication

Robots are a separate, non-human credential class:

- `X-Robot-ID: <code>` + `Authorization: Bearer <device-secret>` headers.
- Only a hash of the device secret (`RobotDevice.secretHash`) is ever
  stored — the raw secret is shown once, at provisioning/rotation time, and
  never again. The secret is never sent to or stored in the browser.
- A disabled robot (`status: DISABLED`) is rejected with `403`, not `401` —
  distinguishing "this credential doesn't exist/is wrong" from "this
  credential is valid but not currently allowed."
- See `docs/robot-protocol.md`.

## Input validation

Every route handler validates its input with Zod before calling a service —
services never see unvalidated shapes. Validation failures return `422
VALIDATION_ERROR` with the Zod issue list, never a raw stack trace.

## Response/error hygiene

- Every API response is the typed envelope `{ data, error, requestId }`
  (`lib/errors.ts`). Unexpected errors are converted to a generic `500
  INTERNAL_ERROR` with no message/stack leaked to the client; only
  `ApiError` and Zod validation messages are considered safe to show.
- Structured logging (`lib/logging.ts`, pino) redacts common secret-shaped
  fields (`password`, `secret`, `authorization`, `deviceSecret`) by key name
  as a backstop — callers are still responsible for not logging full request
  bodies that might carry evidence bytes or tokens.

## Idempotency

`lib/idempotency.ts::resolveIdempotency` is the single implementation every
idempotency-keyed write (counts, product intake, imports, exports, robot
observations) uses: same key + same request hash → return the original
result; same key + different hash → `409 IDEMPOTENCY_CONFLICT`. Hashing is
`lib/hashing.ts::computeRequestHash`, a deterministic (key-sorted) SHA-256 of
the request payload.

## Evidence

- Private object storage only — no public bucket, ever (verified for both
  the local MinIO dev bucket and, per `docs/deployment.md`, the production
  R2 bucket).
- Every upload is verified server-side before being marked usable: actual
  byte length, SHA-256, and a real image decode (not just trusting the
  declared MIME type or file extension) via `sharp`.
- Reads are only ever short-lived signed URLs issued after an authorization
  check, never a permanent link.

## What's not yet implemented (be explicit)

- Rate limiting: there's an obvious integration point (every route already
  goes through a single auth check), but no rate limiter is wired up yet.
- Email delivery: password reset and invitation links are logged, not
  emailed — an operator currently has to copy/paste the link manually.
- Multi-factor authentication is not implemented.
