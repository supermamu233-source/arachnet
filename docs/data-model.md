# Data model

Full source of truth: `prisma/schema.prisma`. This document is the narrative
guide to it — read the schema file for exact field types/defaults.

## Tenancy

- `Organization` is the tenant boundary. Every domain table carries its own
  `organizationId` directly (not just transitively through a warehouse or
  location foreign key) so that tenant-isolation queries and tests stay
  simple: `WHERE organizationId = :callerOrg` is always sufficient, and
  every integration test can assert it.
- `User` is global (an email can only belong to one `User` row), but access
  to any organization is entirely mediated by `Membership { organizationId,
  userId, role }`. A user can belong to more than one organization.
- `Role` enum, most to least privileged: `OWNER, ADMIN, MANAGER, COUNTER,
  VIEWER`.
- `Invitation` is the only path to a new account (see `docs/security.md`).

## Auth tables (better-auth)

`Session`, `Account`, `Verification` follow better-auth's expected schema
shape (so the library's Prisma adapter works unmodified) plus one addition:
`Account.issuer` — better-auth 1.7 scopes credential-account identity by an
`issuer` string (e.g. `"local:credential"`), which is not mentioned in older
better-auth documentation/training data. Every credential `Account` row must
set it or sign-in fails silently with "invalid email or password".

## Warehouses & locations

- `Warehouse { organizationId, name, code, address, timezone, active }`,
  unique on `(organizationId, code)`.
- `Location` is self-referencing (`parentId`) to express the
  Warehouse→Zone→Aisle→Rack→Level→Bin hierarchy from product spec 3.3.
  Unique on `(warehouseId, code)`. `type: LocationType` enum
  (`WAREHOUSE|ZONE|AISLE|RACK|LEVEL|BIN`).

## Products

- `Product { organizationId, sku, name, category, brand, variant,
  defaultUnitsPerBox, active, archivedAt }`, unique on `(organizationId,
  sku)`. Archived, never hard-deleted.
- `ProductBarcode { organizationId, productId, value, type, isPrimary }`,
  unique on `(organizationId, value)` — one barcode value can only ever
  point at one product within a tenant.
- `PackagingRule` — units-per-package rules, can vary by pack type and have a
  validity window (`validFrom`/`validTo`).
- `ProductLocation` — many-to-many assignment of products to their expected
  shelf locations, with `minimumQuantity`/`maximumQuantity` for future
  reorder-point logic.

## Expected stock

- `InventorySource { organizationId, type, name, config }` — a named,
  configured source (not just an enum value), so a tenant can register more
  than one source of the same type (e.g. two ERPs). `type` is
  `MANUAL|CSV|XLSX|ERP|POS|ECOMMERCE|PURCHASING|ROBOT`.
- `ExpectedStockBalance { organizationId, warehouseId, productId, locationId,
  sourceId, quantity, sourceReference, sourceUpdatedAt, importJobId }`. The
  *current authoritative* balance for a product-location pair is the row
  with the latest `sourceUpdatedAt` — there is no separate "current balance"
  table; reconciliation always re-derives it from history. This preserves a
  full audit trail of what the expected value was at any point in time.

## Physical observations (immutable evidence)

- `InventoryCountSession` groups counts into a named run (full/cycle/spot).
- `InventoryCount { boxes, unitsPerBox, looseUnits, physicalQuantity,
  idempotencyKey (unique), requestHash, status }` — `physicalQuantity` is
  always server-computed (`domain/inventory/quantity.ts`), never trusted from
  the client. `status: COMMITTED | VOIDED` — a correction creates a new
  `VOIDED` marker rather than mutating history (product principle 2.2:
  observations are immutable evidence).
- `RobotObservation { boxes, unitsPerBox, looseUnits, observedQuantity,
  confidenceRaw, confidenceLevel, status }`, unique on `(robotId, eventId)`
  for replay-safety. `expectedQuantity`/`difference` are captured at
  ingestion time as a snapshot, not recomputed later.
- `EvidenceAsset { objectKey (unique), purpose, contentType, sha256, width,
  height, status }` — every photograph/robot image, tracked from `PENDING`
  through `VERIFIED` (or `REJECTED`/`DELETED`), never a public URL.

## Product intake (unapproved physical finds)

- `ProductIntake` carries the full capture (raw + normalized EAN/SKU, capture
  method, quantities, candidate match, evidence links, idempotency key) and a
  `status` state machine: `DRAFT → READY_FOR_REVIEW → (MATCHED_EXISTING |
  CONFLICT) → APPROVED | REJECTED`. Approval is one transaction (see
  `server/services/intakes.ts`) that creates/links the product, barcode
  aliases, packaging rules, location assignment, the initial count, and the
  audit record together — see product principle 3.5.

## Reconciliation

- `InventoryDiscrepancy { organizationId, warehouseId, productId, locationId,
  latestCountId?, latestRobotObservationId?, expectedQuantity,
  observedQuantity, difference, severity, status, firstSeenAt, lastSeenAt,
  resolvedAt, resolvedById, resolutionNotes }`, unique on `(organizationId,
  productId, locationId)` — one open discrepancy row per product-location
  pair, updated in place as new observations arrive.
- `DiscrepancyResolutionEvent` is an append-only history table so resolving
  and later reopening a discrepancy never loses the record of what happened
  (product principle 3.7: "retain resolution history").
- `status: DiscrepancyStatus` enum matches product spec 3.7 exactly:
  `MATCH | SHORTAGE | SURPLUS | EXPECTED_MISSING | PHYSICAL_UNVERIFIED |
  REVIEW_REQUIRED | RESOLVED | DISMISSED`.

## Imports & exports

- `ImportJob` / `ExportJob` both carry `idempotencyKey` (unique) +
  `requestHash`, so a retried request with the same key and payload returns
  the original job rather than creating a duplicate, and a same-key-different-
  payload request is rejected with `409` (`lib/idempotency.ts`).
- `ExportJob.filterSnapshot` (JSON) + `snapshotAt` capture exactly what was
  asked for and when, so a downloaded workbook can always be explained later.

## Audit log

- `AuditLog { organizationId, actorType (USER|ROBOT|SYSTEM), actorUserId?,
  actorRobotId?, action, entityType, entityId, oldValue?, newValue?,
  requestId?, createdAt }`. Written by `server/services/audit.ts`'s
  `recordAudit()` — every service that creates/updates/approves/resolves
  something calls it. Rows are never updated or deleted by application code.
