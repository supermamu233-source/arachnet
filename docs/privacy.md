# Privacy and ethical use

## Data minimization

- Evidence photographs are captured for exactly one purpose each
  (`EvidencePurpose: PRODUCT_IMAGE | LABEL_IMAGE | COUNT_IMAGE | SHELF_IMAGE |
  BARCODE_CROP | ROBOT_IMAGE`) — the purpose is recorded on the asset and
  never repurposed silently.
- Only the fields needed for reconciliation and audit are captured on a
  count or intake — there is no free-form tracking of who was near a
  location beyond the `createdById` attribution a count already requires.

## Retention

- `EvidenceAsset.status` includes `DELETED` with a `deletedAt` timestamp —
  deletion is a state transition on the row, never a silent hard-delete, so
  there is always a record that an asset existed and was removed.
- Organization-controlled retention (an admin-configurable "delete evidence
  older than N days" policy) is designed for but not yet scheduled as a
  background job in this MVP — see `docs/operations.md` for the current
  manual deletion path (`DELETE /api/evidence/:id`, `MANAGER`+ only).

## What Arachnet explicitly does not do

- **No facial recognition.** Images are stored and displayed as captured;
  nothing in this codebase runs face detection or identification.
- **No employee-performance scoring from warehouse images.** A count's
  `createdById` exists for audit/accountability of the *count*, not to
  score the person.
- **No automatic disciplinary conclusions.** A discrepancy is a data fact
  (expected vs. observed quantity); resolving it always requires a human
  decision (`InventoryDiscrepancy.resolvedById` + `resolutionNotes`) — the
  system never asserts a cause (theft, error, damage) on its own.
- **No model training on customer images** without explicit permission —
  none of the image-processing code in this repo (`sharp` resizing/
  thumbnailing) sends images to any third-party ML service; OCR (Tesseract.js)
  runs entirely in the browser and is user-triggered, not automatic.

## Incidental capture of people

Warehouse photographs may accidentally include a person in frame. Because
evidence is private by default (`docs/security.md`) and access to it is
logged the same way any other resource read is (via the standard
authorization path — there is no separate unaudited image-viewing route),
exposure is already limited to authorized organization members. A dedicated
access log specifically for evidence views (beyond the generic audit log) is
a reasonable future addition, not yet built.

## Export and deletion

- CSV/XLSX exports are generated from an explicit snapshot
  (`ExportJob.filterSnapshot` + `snapshotAt`), so what left the system and
  when is always reconstructable.
- There is no cross-organization data sharing anywhere in the schema —
  every table is scoped by `organizationId`, and deleting an `Organization`
  row cascades to all of its data (see the `onDelete: Cascade` relations in
  `prisma/schema.prisma`), giving a clean "delete this tenant's data" path if
  ever needed (not currently exposed as a self-service UI action — an
  operator would run it directly against the database, deliberately, since
  it's irreversible).
