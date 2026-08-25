# Robot ingestion protocol

Covers product spec sections 3.8, 9, 15, and 17: how an authenticated robot
device (or the simulator standing in for one, see `tools/robot-simulator/`)
reports physical observations into Arachnet.

## Authentication

Robots are a completely separate credential class from human sessions —
there is no cookie, no better-auth session, nothing shared with the
browser-facing dashboard. Every robot-authenticated request carries two
headers:

```
X-Robot-ID: scout-001
Authorization: Bearer <device-secret>
```

`X-Robot-ID` is the operator-assigned `RobotDevice.code`. The bearer token is
the device's raw secret — a long random value shown to the operator exactly
once, at creation or rotation time (dashboard: **Robots** -> create/rotate),
and never retrievable afterwards. Only a hash of it (`RobotDevice.secretHash`,
via the same `hashPassword` primitive human password auth uses) is ever
persisted.

`server/auth/robot-auth.ts`'s `authenticateRobot()` performs this check on
every robot route:

1. Missing `X-Robot-ID` or `Authorization: Bearer ...` -> `401
   ROBOT_UNAUTHENTICATED`.
2. No `RobotDevice` with that `code` -> `401 ROBOT_UNAUTHENTICATED`.
3. Secret doesn't verify against the stored hash -> `401
   ROBOT_UNAUTHENTICATED`. (Deliberately the same error/code as "unknown
   code" — a caller can't distinguish "wrong code" from "wrong secret" and
   so can't use the response to enumerate valid device codes.)
4. Device found, secret verifies, but `status === "DISABLED"` -> `403
   ROBOT_DISABLED`.
5. Otherwise: `lastSeenAt` is updated to now, and the request proceeds with
   the device's `{ robotId, organizationId, warehouseId }`.

`RobotDevice.code` is only unique per-organization in the schema
(`@@unique([organizationId, code])`) — a robot has no way to know its own
`organizationId` ahead of authenticating, so the lookup is by `code` alone
across all organizations. Operators are expected to keep device codes
effectively globally unique in practice (the seed data's `scout-001` is an
example).

Robot secrets are never logged (`lib/logging.ts`'s pino redaction list
already covers `secret`/`*.secret`/`deviceSecret`/`*.deviceSecret` key
names) and never sent to a browser except at the one-time creation/rotation
moment, rendered directly in the dashboard response.

## The end-to-end sequence

A robot reports one physical observation in four calls:

```
POST /api/robot/evidence/presign    -> { uploadUrl, assetId, objectKey }
PUT  <uploadUrl>                    -> raw image bytes (direct to object storage)
POST /api/robot/evidence/finalize   -> { ...asset, status: "VERIFIED" }
POST /api/robot/observations        -> { observationId, status, expectedQuantity, observedQuantity, difference, ... }
```

### 1. `POST /api/robot/evidence/presign`

Request:
```json
{ "contentType": "image/jpeg", "maxBytes": 2097152 }
```
`contentType` must be one of `image/jpeg` | `image/png` | `image/webp`.
Response `data`: `{ uploadUrl, assetId, objectKey }`. This is the
robot-authenticated twin of the human `/api/evidence/presign` route —
same request/response shape, same underlying `createPresignedUpload()`
(`server/services/evidence.ts`, untouched), but reachable with robot
credentials and always tagged `purpose: "ROBOT_IMAGE"`.

### 2. `PUT <uploadUrl>`

The robot PUTs the raw image bytes directly to the returned presigned URL
(MinIO locally, R2 in production) — this request is not authenticated with
robot headers at all; the presigned URL itself is the credential.

### 3. `POST /api/robot/evidence/finalize`

Request: `{ "assetId": "<from step 1>" }`. Delegates to the same
`finalizeEvidence()` the human flow uses — the bytes are actually
downloaded and decoded server-side (never trusting the declared
Content-Type alone), hashed, and DISPLAY/THUMB variants are derived. On
success the asset's `status` becomes `"VERIFIED"` and only then can it be
referenced by an observation. Finalizing an already-`VERIFIED` asset again
is treated as an idempotent replay (same as the human route), not an error.

> **Why a separate robot finalize route exists at all**: the human
> `/api/evidence/finalize` route only accepts a better-auth session cookie.
> Without a robot-authenticated equivalent, a robot could presign and upload
> an image but could never get it to `VERIFIED`, and so could never satisfy
> the observation endpoint's evidence requirement. See "Deviations" below
> for how the underlying `createdById`/`actorUserId` attribution is handled.

### 4. `POST /api/robot/observations`

Request (matches the product spec example):
```json
{
  "eventId": "3f2a1c9e-...-uuid",
  "capturedAt": "2026-08-25T04:12:00.123Z",
  "locationCode": "WH1-A03-RB-L04",
  "ean": "8431234567890",
  "boxes": 12,
  "looseUnits": 2,
  "confidence": 0.97,
  "evidenceIds": ["<assetId from step 3>"],
  "rawPayload": { "scanner": "simulator", "camera": "sample-image" }
}
```

Response `data`:
```json
{
  "observationId": "...",
  "eventId": "3f2a1c9e-...-uuid",
  "status": "ACCEPTED",
  "confidenceLevel": "HIGH",
  "productId": "...",
  "locationId": "...",
  "expectedQuantity": 82,
  "observedQuantity": 74,
  "difference": -8,
  "replay": false
}
```

Processing, in order (`server/services/robot-observations.ts`,
`ingestObservation()`):

1. **Idempotency**: a deterministic `requestHash` is computed over the
   semantically meaningful fields (`locationCode`, `ean`, `boxes`,
   `looseUnits`, `confidence`, `evidenceIds`, `capturedAt`, `rawPayload`) —
   deliberately excluding `eventId` itself (the lookup key, not payload) and
   any server-assigned timestamp. The existing `RobotObservation` row for
   `{robotId, eventId}` (if any) is looked up and run through
   `resolveIdempotency()`:
   - No existing row -> proceed as a new observation.
   - Existing row, same hash -> **replay**: the original stored result is
     returned untouched (`data.replay: true`, HTTP 200). Evidence is not
     re-validated and reconciliation is not re-run.
   - Existing row, different hash -> **409 `IDEMPOTENCY_CONFLICT`**. The
     `eventId` was reused for a logically different request; this always
     fails loudly rather than silently overwriting the original.
2. **Location resolution**: `locationCode` is looked up scoped to the
   robot's own `organizationId` + `warehouseId`. Not found -> `404
   LOCATION_NOT_FOUND`.
3. **Evidence validation**: every id in `evidenceIds` must resolve to a
   `VERIFIED` `EvidenceAsset` owned by this organization. An empty list, a
   missing id, a not-yet-`VERIFIED` asset, or one from another organization
   -> `422 VALIDATION_ERROR`. This is required regardless of whether the
   EAN below matches a product — a robot must always submit an inspectable
   image.
4. **Product resolution (EAN, exact match only)**: the org's
   `ProductBarcode` rows are compared against the scanned `ean` using the
   same trim/uppercase normalization
   `domain/products/matching.ts`'s `findExactMatches` uses for barcode
   comparison (product principle 2.3 — never fuzzy). If nothing matches,
   the observation is still recorded (see "Unmatched EAN" below) rather than
   rejected.
5. **Server-side quantity calculation**: `observedQuantity` is *always*
   computed server-side via `domain/inventory/quantity.ts`'s
   `calculatePhysicalQuantity({ boxes, unitsPerBox, looseUnits })`, using
   `unitsPerBox` from the matched **product's own** `defaultUnitsPerBox` —
   never a robot-supplied total or a robot-supplied `unitsPerBox`. The robot
   is deliberately incapable of asserting an authoritative quantity.
6. **Confidence classification**:
   `domain/reconciliation/confidence.ts`'s `classifyConfidence(confidence,
   hasCompleteEvidence)`. Evidence is required to be non-empty by step 3, so
   `hasCompleteEvidence` is always true when this runs; a `null`/`undefined`
   confidence, or a raw value below the configured "low" threshold, still
   classifies as `REVIEW_REQUIRED`.
7. **Expected balance snapshot**: the current authoritative
   `ExpectedStockBalance.quantity` for this product+location (latest by
   `sourceUpdatedAt`, same rule `recalculateProductLocation` uses) is
   snapshotted onto `expectedQuantity`/`difference` on the `RobotObservation`
   row itself — this is a point-in-time record, separate from the live
   `InventoryDiscrepancy`, and this call **never writes** to
   `ExpectedStockBalance`.
8. **Persist + audit**: the `RobotObservation` row is created (`status:
   "ACCEPTED"` or `"REVIEW_REQUIRED"`), linked to the evidence assets, and
   an `AuditLog` row is recorded with `actorRobotId` (never `actorUserId`) so
   the audit trail correctly shows a machine, not a human, performed this
   write.
9. **Reconciliation — gated on review status**: `recalculateProductLocation`
   (`server/services/reconciliation.ts`, untouched) is called **only when
   `status === "ACCEPTED"` and a product was matched**. A `REVIEW_REQUIRED`
   observation is stored for a human to see, but is deliberately *not* used
   to auto-create/update/resolve the live `InventoryDiscrepancy` — see
   "Why REVIEW_REQUIRED skips reconciliation" below.

## Confidence -> REVIEW_REQUIRED behavior

| Situation | `confidenceLevel` | `status` | Reconciliation runs? |
| --- | --- | --- | --- |
| High raw confidence, evidence present, product matched | `HIGH`/`MEDIUM`/`LOW` (per configured thresholds) | `ACCEPTED` | Yes |
| Raw confidence below the "low" threshold, or missing | `REVIEW_REQUIRED` | `REVIEW_REQUIRED` | No |
| EAN doesn't match any product | `REVIEW_REQUIRED` (forced) | `REVIEW_REQUIRED` | No |

A `REVIEW_REQUIRED` observation is still fully persisted (nothing is
dropped) and still visible on the robot's detail page in the dashboard — it
simply can't be the thing that silently moves the needle on an official
discrepancy until a human has looked at it.

## Why `REVIEW_REQUIRED` skips reconciliation (design rationale)

Product principles 2.2 and 2.8 are explicit: a low-confidence or
evidence-incomplete observation must never auto-correct an external/expected
source, and there is no "fake certainty" — an operational confidence score
is not a statistical accuracy guarantee. `recalculateProductLocation`
itself *is* willing to consider a `REVIEW_REQUIRED` observation as the
"latest observation" input when it runs for some *other* reason (e.g. a
later human count, or a cron-style `recalculateAll`) — that read-side
behavior belongs to `server/services/reconciliation.ts` and wasn't changed
here. What this ingestion path controls is only whether *storing this
particular observation* is itself the trigger that recalculates the
discrepancy. Deliberately, it is not: an operator should not see a
discrepancy silently flip open/closed/change severity as a direct,
un-reviewed side effect of a robot observation the system itself has
flagged as needing review. If the same location is later reconciled through
any other path, the stored `REVIEW_REQUIRED` row can still be picked up
then — that's an explicit, separate action, not this one.

## Unmatched EAN (not required by the test matrix, but must not crash)

If the scanned `ean` doesn't match any `ProductBarcode` in the organization,
the observation is still recorded — `productId` is left `null`,
`barcodeObserved` stores the raw scanned value, and:

- `unitsPerBox` is stored as `1` — not because that's a real unit count, but
  because the schema column is non-nullable and there is no product to take
  a real value from. `observedQuantity` in this case (`boxes + looseUnits`)
  is informational only and must not be read as an authoritative physical
  count.
- `expectedQuantity`/`difference` are left `null` — there is nothing to
  compare against.
- `confidenceLevel`/`status` are forced to `REVIEW_REQUIRED` regardless of
  the robot's raw confidence value: an unrecognized item always needs a
  human to identify/catalog it before anything derived from it can matter.
- `recalculateProductLocation` is never called for this row (it operates on
  a specific product+location pair, which doesn't exist here).

## Idempotency & replay semantics — summary

| Request | Result |
| --- | --- |
| New `eventId` | Processed normally; `RobotObservation` created |
| Same `eventId`, identical payload (by `requestHash`) | **Replay** — original result returned, `data.replay: true`, HTTP 200, nothing reprocessed |
| Same `eventId`, different payload | **409 `IDEMPOTENCY_CONFLICT`** |

This mirrors the existing idempotency pattern used elsewhere in the app
(`InventoryCount`/`ProductIntake`/import-export jobs' `idempotencyKey` +
`requestHash` + `lib/idempotency.ts`'s `resolveIdempotency`), except the
lookup key is the schema's `@@unique([robotId, eventId])` rather than a
separate `idempotencyKey` column.

## Deviations from a literal reading of the brief

**Robot-attributed evidence uploads need a User-shaped actor.**
`server/services/evidence.ts` (owned by another workstream, not modified
here) attributes every presigned upload and every finalize call to a real
`User` row via a foreign-key-constrained `createdById`/`actorUserId` column
— there was no robot actor concept when it was written. Rather than touch
that file or `prisma/schema.prisma`, the robot-authenticated
presign/finalize routes attribute the action to one deterministic,
lazily-created placeholder `User` per organization (email
`robot-pipeline+<organizationId>@arachnet.internal`, see
`getRobotPipelineUserId()` in `server/auth/robot-auth.ts`), created on first
use and reused after. This only exists to satisfy that foreign key — the
actually-accountable actor (which robot device) is still correctly recorded
via `recordAudit({ actorRobotId })` in `ingestObservation`, and the
`RobotObservation` row always links back to the real `RobotDevice`. The one
cosmetic side effect: the `evidence.finalized` audit entry that
`finalizeEvidence` itself writes will show this placeholder user as
`actorUserId` for robot-originated uploads, rather than showing the robot.
If this matters going forward, the real fix is to make
`createdById`/`actorUserId` on those two functions accept an
`actorRobotId` alternative, which requires touching `evidence.ts` (out of
this workstream's boundary).
