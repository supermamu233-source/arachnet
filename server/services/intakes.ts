import { Prisma } from "@/lib/generated/prisma/client";
import type { InventoryCount, Product, ProductIntake } from "@/lib/generated/prisma/client";
import type {
  BarcodeType,
  CaptureMethod,
  EvidencePurpose,
  ProductIntakeStatus,
} from "@/lib/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/errors";
import { computeRequestHash } from "@/lib/hashing";
import { resolveIdempotency } from "@/lib/idempotency";
import { recordAudit } from "@/server/services/audit";
import { recalculateProductLocation } from "@/server/services/reconciliation";
import { calculatePhysicalQuantity } from "@/domain/inventory/quantity";
import { normalizeIdentifier } from "@/domain/products/ean";
import { findExactMatches, type CatalogEntry } from "@/domain/products/matching";

type Tx = Prisma.TransactionClient;

/**
 * Product intake service (product spec sections 3.5, 9, 14) — the workflow
 * for products physically found but not yet approved in the catalogue.
 *
 * CONFLICT surfacing decision: the schema stores only a single
 * `candidateProductId` column, but a CONFLICT can involve two distinct
 * candidates (EAN matches product A, SKU matches product B). We store the
 * more specific candidate (EAN match preferred over SKU match) in
 * `candidateProductId` so existing UI that reads that column still shows
 * *something* useful, and we additionally write a system-authored note into
 * `decisionNotes` enumerating every distinct candidate product id found, so a
 * human reviewer always has the full picture without needing a new column.
 * `rawEan`/`rawSku` remain on the intake row itself for the reviewer to
 * cross-check manually against each candidate.
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function loadCatalog(organizationId: string): Promise<CatalogEntry[]> {
  const products = await prisma.product.findMany({
    where: { organizationId },
    select: { id: true, sku: true, barcodes: { select: { value: true } } },
  });
  // No separate alias table exists yet — mirrors server/services/products.ts.
  return products.map((product) => ({
    productId: product.id,
    sku: product.sku,
    barcodes: product.barcodes.map((b) => b.value),
    aliases: [],
  }));
}

interface MatchClassification {
  status: ProductIntakeStatus;
  candidateProductId: string | null;
  decisionNotes: string | null;
}

/**
 * Runs exact matching (EAN and/or SKU) against the organization's catalog
 * and classifies the result per product principle 2.3: exact match only,
 * never auto-approved. See the CONFLICT-surfacing note above the file header
 * for how multiple distinct candidates are recorded.
 */
async function classifyMatch(
  organizationId: string,
  normalizedEan: string | null,
  normalizedSku: string | null,
): Promise<MatchClassification> {
  if (!normalizedEan && !normalizedSku) {
    return { status: "READY_FOR_REVIEW", candidateProductId: null, decisionNotes: null };
  }

  const catalog = await loadCatalog(organizationId);
  const matchedProductIds = new Set<string>();
  let eanMatchProductId: string | null = null;
  let skuMatchProductId: string | null = null;

  if (normalizedEan) {
    const matches = findExactMatches(normalizedEan, catalog);
    if (matches.length > 0) {
      eanMatchProductId = matches[0].productId;
      for (const m of matches) matchedProductIds.add(m.productId);
    }
  }
  if (normalizedSku) {
    const matches = findExactMatches(normalizedSku, catalog);
    if (matches.length > 0) {
      skuMatchProductId = matches[0].productId;
      for (const m of matches) matchedProductIds.add(m.productId);
    }
  }

  if (matchedProductIds.size === 0) {
    return { status: "READY_FOR_REVIEW", candidateProductId: null, decisionNotes: null };
  }

  if (matchedProductIds.size === 1) {
    return { status: "MATCHED_EXISTING", candidateProductId: [...matchedProductIds][0], decisionNotes: null };
  }

  const candidateProductId = eanMatchProductId ?? skuMatchProductId ?? [...matchedProductIds][0];
  const decisionNotes =
    `[system] Multiple exact candidates matched at intake creation/update — a human reviewer must resolve ` +
    `this manually before approval. EAN "${normalizedEan ?? "n/a"}" matched product ${eanMatchProductId ?? "none"}; ` +
    `SKU "${normalizedSku ?? "n/a"}" matched product ${skuMatchProductId ?? "none"}. ` +
    `All distinct candidate product ids: ${[...matchedProductIds].join(", ")}.`;

  return { status: "CONFLICT", candidateProductId, decisionNotes };
}

async function assertEvidenceReady(
  organizationId: string,
  assetId: string,
  expectedPurpose: EvidencePurpose,
) {
  const asset = await prisma.evidenceAsset.findUnique({ where: { id: assetId } });
  if (!asset) {
    throw new ApiError("EVIDENCE_NOT_FOUND", `Evidence asset "${assetId}" not found.`);
  }
  if (asset.organizationId !== organizationId) {
    throw new ApiError("ORGANIZATION_MISMATCH", "Evidence asset does not belong to this organization.");
  }
  if (asset.purpose !== expectedPurpose) {
    throw new ApiError(
      "VALIDATION_ERROR",
      `Evidence asset "${assetId}" has purpose ${asset.purpose}, expected ${expectedPurpose}.`,
    );
  }
  if (asset.status !== "VERIFIED") {
    throw new ApiError("EVIDENCE_NOT_READY", `Evidence asset "${assetId}" is ${asset.status}, not yet verified.`);
  }
  return asset;
}

async function assertLocationInOrg(organizationId: string, locationId: string) {
  const location = await prisma.location.findUnique({ where: { id: locationId } });
  if (!location || location.organizationId !== organizationId) {
    throw new ApiError("LOCATION_NOT_FOUND", "Location not found.");
  }
  return location;
}

function inferBarcodeType(value: string): BarcodeType {
  if (/^\d{13}$/.test(value)) return "EAN13";
  if (/^\d{8}$/.test(value)) return "EAN8";
  return "OTHER";
}

// ---------------------------------------------------------------------------
// createIntake
// ---------------------------------------------------------------------------

export interface CreateIntakeParams {
  organizationId: string;
  locationId: string;
  rawEan?: string;
  eanCaptureMethod?: CaptureMethod;
  rawSku?: string;
  skuCaptureMethod?: CaptureMethod;
  productImageId?: string;
  labelImageId?: string;
  boxes: number;
  unitsPerBox: number;
  looseUnits: number;
  createdById: string;
  idempotencyKey: string;
  requestHash: string;
}

export interface CreateIntakeResult {
  intake: ProductIntake;
  /** True when this call replayed an already-processed idempotency key —
   * the returned intake is the ORIGINAL row, nothing was recomputed. */
  replay: boolean;
}

export async function createIntake(params: CreateIntakeParams): Promise<CreateIntakeResult> {
  const existing = await prisma.productIntake.findUnique({ where: { idempotencyKey: params.idempotencyKey } });
  const idempotency = resolveIdempotency(existing, params.requestHash);
  if (idempotency.outcome === "replay") {
    return { intake: idempotency.record, replay: true };
  }

  await assertLocationInOrg(params.organizationId, params.locationId);

  const normalizedEan = params.rawEan ? normalizeIdentifier(params.rawEan) : null;
  const normalizedSku = params.rawSku ? normalizeIdentifier(params.rawSku) : null;

  const physicalQuantity = calculatePhysicalQuantity({
    boxes: params.boxes,
    unitsPerBox: params.unitsPerBox,
    looseUnits: params.looseUnits,
  });

  if (params.productImageId) {
    await assertEvidenceReady(params.organizationId, params.productImageId, "PRODUCT_IMAGE");
  }
  if (params.labelImageId) {
    await assertEvidenceReady(params.organizationId, params.labelImageId, "LABEL_IMAGE");
  }

  const { status, candidateProductId, decisionNotes } = await classifyMatch(
    params.organizationId,
    normalizedEan,
    normalizedSku,
  );

  const intake = await prisma.productIntake.create({
    data: {
      organizationId: params.organizationId,
      locationId: params.locationId,
      rawEan: params.rawEan,
      normalizedEan,
      eanCaptureMethod: params.eanCaptureMethod,
      rawSku: params.rawSku,
      normalizedSku,
      skuCaptureMethod: params.skuCaptureMethod,
      productImageId: params.productImageId,
      labelImageId: params.labelImageId,
      boxes: params.boxes,
      unitsPerBox: params.unitsPerBox,
      looseUnits: params.looseUnits,
      physicalQuantity,
      candidateProductId,
      status,
      decisionNotes,
      createdById: params.createdById,
      idempotencyKey: params.idempotencyKey,
      requestHash: params.requestHash,
    },
  });

  await recordAudit({
    organizationId: params.organizationId,
    actorUserId: params.createdById,
    action: "product_intake.created",
    entityType: "ProductIntake",
    entityId: intake.id,
    newValue: { status: intake.status, candidateProductId: intake.candidateProductId },
  });

  return { intake, replay: false };
}

// ---------------------------------------------------------------------------
// listIntakes / getIntake
// ---------------------------------------------------------------------------

export interface ListIntakesParams {
  organizationId: string;
  status?: ProductIntakeStatus;
}

const INTAKE_LIST_CAP = 200;

export async function listIntakes(params: ListIntakesParams) {
  return prisma.productIntake.findMany({
    where: {
      organizationId: params.organizationId,
      ...(params.status ? { status: params.status } : {}),
    },
    orderBy: { createdAt: "desc" },
    include: { location: true, candidateProduct: true },
    take: INTAKE_LIST_CAP,
  });
}

export async function getIntake(organizationId: string, intakeId: string) {
  const intake = await prisma.productIntake.findUnique({
    where: { id: intakeId },
    include: {
      location: true,
      candidateProduct: true,
      productImage: true,
      labelImage: true,
      createdBy: { select: { id: true, name: true, email: true } },
      decidedBy: { select: { id: true, name: true, email: true } },
    },
  });
  if (!intake) {
    throw new ApiError("NOT_FOUND", "Product intake not found.");
  }
  if (intake.organizationId !== organizationId) {
    throw new ApiError("ORGANIZATION_MISMATCH", "Resource does not belong to this organization.");
  }
  return intake;
}

// ---------------------------------------------------------------------------
// updateIntake (pre-submission wizard edits)
// ---------------------------------------------------------------------------

export interface UpdateIntakeParams {
  organizationId: string;
  intakeId: string;
  actorUserId: string;
  locationId?: string;
  rawEan?: string;
  eanCaptureMethod?: CaptureMethod;
  rawSku?: string;
  skuCaptureMethod?: CaptureMethod;
  productImageId?: string;
  labelImageId?: string;
  boxes?: number;
  unitsPerBox?: number;
  looseUnits?: number;
}

/**
 * Updates a not-yet-decided intake — used by the wizard to persist partial
 * progress (photos, quantities) across steps before final submission.
 *
 * Note: nothing in `createIntake` ever leaves a row in `DRAFT` (it always
 * runs matching to completion and lands on READY_FOR_REVIEW/
 * MATCHED_EXISTING/CONFLICT immediately), and the wizard shipped in this
 * phase collects all fields client-side and submits once at the final
 * "Guardar" step — so this endpoint currently has no caller in the UI. It's
 * still implemented per the brief so a future incremental-save UX (or a
 * DRAFT row created directly) has a correct, permission-checked target.
 * Permission rule: editable while `status === "DRAFT"` by any COUNTER+, or
 * by the original creator regardless of status, but never once the intake
 * has reached a terminal APPROVED/REJECTED state.
 */
export async function updateIntake(params: UpdateIntakeParams) {
  const existing = await prisma.productIntake.findUnique({ where: { id: params.intakeId } });
  if (!existing) {
    throw new ApiError("NOT_FOUND", "Product intake not found.");
  }
  if (existing.organizationId !== params.organizationId) {
    throw new ApiError("ORGANIZATION_MISMATCH", "Resource does not belong to this organization.");
  }
  if (existing.status === "APPROVED" || existing.status === "REJECTED") {
    throw new ApiError("CONFLICT", `Cannot update an intake that is already ${existing.status}.`);
  }
  const isCreator = existing.createdById === params.actorUserId;
  if (existing.status !== "DRAFT" && !isCreator) {
    throw new ApiError("FORBIDDEN", "Only the original creator may update an intake once it has left DRAFT status.");
  }

  if (params.locationId) {
    await assertLocationInOrg(params.organizationId, params.locationId);
  }
  if (params.productImageId) {
    await assertEvidenceReady(params.organizationId, params.productImageId, "PRODUCT_IMAGE");
  }
  if (params.labelImageId) {
    await assertEvidenceReady(params.organizationId, params.labelImageId, "LABEL_IMAGE");
  }

  const rawEan = params.rawEan ?? existing.rawEan ?? undefined;
  const rawSku = params.rawSku ?? existing.rawSku ?? undefined;
  const normalizedEan = rawEan ? normalizeIdentifier(rawEan) : null;
  const normalizedSku = rawSku ? normalizeIdentifier(rawSku) : null;

  const boxes = params.boxes ?? existing.boxes;
  const unitsPerBox = params.unitsPerBox ?? existing.unitsPerBox;
  const looseUnits = params.looseUnits ?? existing.looseUnits;
  const physicalQuantity = calculatePhysicalQuantity({ boxes, unitsPerBox, looseUnits });

  const { status, candidateProductId, decisionNotes } = await classifyMatch(
    params.organizationId,
    normalizedEan,
    normalizedSku,
  );

  const updated = await prisma.productIntake.update({
    where: { id: existing.id },
    data: {
      locationId: params.locationId ?? existing.locationId,
      rawEan: rawEan ?? null,
      normalizedEan,
      eanCaptureMethod: params.eanCaptureMethod ?? existing.eanCaptureMethod,
      rawSku: rawSku ?? null,
      normalizedSku,
      skuCaptureMethod: params.skuCaptureMethod ?? existing.skuCaptureMethod,
      productImageId: params.productImageId ?? existing.productImageId,
      labelImageId: params.labelImageId ?? existing.labelImageId,
      boxes,
      unitsPerBox,
      looseUnits,
      physicalQuantity,
      candidateProductId,
      status,
      decisionNotes,
    },
  });

  await recordAudit({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    action: "product_intake.updated",
    entityType: "ProductIntake",
    entityId: updated.id,
    oldValue: { status: existing.status },
    newValue: { status: updated.status, candidateProductId: updated.candidateProductId },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// rejectIntake
// ---------------------------------------------------------------------------

export interface RejectIntakeParams {
  organizationId: string;
  intakeId: string;
  actorUserId: string;
  notes?: string;
}

export async function rejectIntake(params: RejectIntakeParams) {
  const existing = await prisma.productIntake.findUnique({ where: { id: params.intakeId } });
  if (!existing) {
    throw new ApiError("NOT_FOUND", "Product intake not found.");
  }
  if (existing.organizationId !== params.organizationId) {
    throw new ApiError("ORGANIZATION_MISMATCH", "Resource does not belong to this organization.");
  }
  if (existing.status === "APPROVED" || existing.status === "REJECTED") {
    throw new ApiError("CONFLICT", `Cannot reject an intake that is already ${existing.status}.`);
  }

  const updated = await prisma.productIntake.update({
    where: { id: existing.id },
    data: {
      status: "REJECTED",
      decidedById: params.actorUserId,
      decidedAt: new Date(),
      decisionNotes: params.notes,
    },
  });

  await recordAudit({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    action: "product_intake.rejected",
    entityType: "ProductIntake",
    entityId: updated.id,
    oldValue: { status: existing.status },
    newValue: { status: updated.status, notes: params.notes },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// approveIntake
// ---------------------------------------------------------------------------

export interface ApproveIntakeProductDetails {
  sku: string;
  name: string;
  category?: string;
  brand?: string;
  /** Falls back to the intake's own unitsPerBox when omitted — a genuinely
   * new product otherwise has no other source for this field. */
  defaultUnitsPerBox?: number;
}

export interface ApproveIntakeParams {
  organizationId: string;
  intakeId: string;
  actorUserId: string;
  /** Required to create a new product (when the intake has no
   * candidateProductId, i.e. READY_FOR_REVIEW/CONFLICT paths taken as
   * "create new"). Optional — and ignored for product-creation purposes —
   * when linking to an existing MATCHED_EXISTING candidate. Passing this
   * even when a candidate exists overrides the link and creates a new
   * product instead (the caller explicitly rejected the suggested match). */
  productDetails?: ApproveIntakeProductDetails;
}

export interface ApproveIntakeResult {
  intake: ProductIntake;
  product: Product;
  count: InventoryCount;
}

export async function approveIntake(params: ApproveIntakeParams): Promise<ApproveIntakeResult> {
  const intake = await prisma.productIntake.findUnique({ where: { id: params.intakeId } });
  if (!intake) {
    throw new ApiError("NOT_FOUND", "Product intake not found.");
  }
  if (intake.organizationId !== params.organizationId) {
    throw new ApiError("ORGANIZATION_MISMATCH", "Resource does not belong to this organization.");
  }
  if (intake.status !== "READY_FOR_REVIEW" && intake.status !== "MATCHED_EXISTING") {
    throw new ApiError(
      "CONFLICT",
      `Cannot approve an intake with status ${intake.status}. Only READY_FOR_REVIEW or MATCHED_EXISTING intakes may be approved.`,
    );
  }

  const isLinkingExisting = Boolean(intake.candidateProductId) && !params.productDetails;
  if (!isLinkingExisting && !params.productDetails) {
    throw new ApiError("VALIDATION_ERROR", "productDetails is required to create a new product for this intake.");
  }

  if (isLinkingExisting) {
    const candidate = await prisma.product.findUnique({ where: { id: intake.candidateProductId! } });
    if (!candidate || candidate.organizationId !== params.organizationId) {
      throw new ApiError("PRODUCT_NOT_FOUND", "Candidate product not found.");
    }
  }

  const location = await assertLocationInOrg(params.organizationId, intake.locationId);

  let txResult;
  try {
    txResult = await prisma.$transaction(async (tx: Tx) => {
      // 1/2. Create or link the product.
      const product = isLinkingExisting
        ? await tx.product.findUniqueOrThrow({ where: { id: intake.candidateProductId! } })
        : await tx.product.create({
            data: {
              organizationId: params.organizationId,
              sku: params.productDetails!.sku,
              name: params.productDetails!.name,
              category: params.productDetails!.category,
              brand: params.productDetails!.brand,
              defaultUnitsPerBox: params.productDetails!.defaultUnitsPerBox ?? intake.unitsPerBox,
            },
          });

      // 3. Create barcode aliases for any physically-captured identifier not
      // already registered on this product.
      const existingBarcodes = await tx.productBarcode.findMany({ where: { productId: product.id } });
      const existingValues = new Set(existingBarcodes.map((b) => normalizeIdentifier(b.value)));
      let barcodeCount = existingBarcodes.length;

      if (intake.normalizedEan && !existingValues.has(intake.normalizedEan)) {
        const value = intake.rawEan ?? intake.normalizedEan;
        await tx.productBarcode.create({
          data: {
            organizationId: params.organizationId,
            productId: product.id,
            value,
            type: inferBarcodeType(intake.normalizedEan),
            isPrimary: barcodeCount === 0,
          },
        });
        existingValues.add(intake.normalizedEan);
        barcodeCount += 1;
      }
      if (intake.normalizedSku && !existingValues.has(intake.normalizedSku)) {
        const value = intake.rawSku ?? intake.normalizedSku;
        await tx.productBarcode.create({
          data: {
            organizationId: params.organizationId,
            productId: product.id,
            value,
            type: inferBarcodeType(intake.normalizedSku),
            isPrimary: barcodeCount === 0,
          },
        });
      }

      // 4. Create packaging rule — only for a genuinely new product; an
      // existing product already has its packaging rules.
      if (!isLinkingExisting) {
        await tx.packagingRule.create({
          data: {
            productId: product.id,
            name: "Caja estándar",
            packageType: "BOX",
            unitsContained: intake.unitsPerBox,
          },
        });
      }

      // 5. Assign the location.
      await tx.productLocation.upsert({
        where: { productId_locationId: { productId: product.id, locationId: intake.locationId } },
        update: {},
        create: { productId: product.id, locationId: intake.locationId },
      });

      // 6. Promote approved photographs: the schema has no Product.evidence
      // relation to re-parent onto, and the EvidenceAsset rows are already
      // VERIFIED and linked to this intake (and, below, to the new initial
      // InventoryCount) — so "promotion" here means leaving them as-is; they
      // remain permanently reachable from the intake and from the count for
      // the product's evidence trail. See report for full reasoning.

      // 7. Create the initial count.
      const evidenceIds = [intake.productImageId, intake.labelImageId].filter(
        (id): id is string => Boolean(id),
      );
      const countIdempotencyKey = `${intake.idempotencyKey}:initial-count`;
      const countRequestHash = computeRequestHash({
        source: "product_intake_approval",
        intakeId: intake.id,
        productId: product.id,
        physicalQuantity: intake.physicalQuantity,
      });

      const count = await tx.inventoryCount.create({
        data: {
          organizationId: params.organizationId,
          warehouseId: location.warehouseId,
          productId: product.id,
          locationId: intake.locationId,
          boxes: intake.boxes,
          unitsPerBox: intake.unitsPerBox,
          looseUnits: intake.looseUnits,
          physicalQuantity: intake.physicalQuantity,
          observation: "Alta inicial generada automáticamente al aprobar el intake de producto.",
          status: "COMMITTED",
          capturedAt: intake.createdAt,
          createdById: params.actorUserId,
          idempotencyKey: countIdempotencyKey,
          requestHash: countRequestHash,
          evidence: evidenceIds.length > 0 ? { connect: evidenceIds.map((id) => ({ id })) } : undefined,
        },
      });

      // 8. Create the audit record.
      await recordAudit(
        {
          organizationId: params.organizationId,
          actorUserId: params.actorUserId,
          action: "product_intake.approved",
          entityType: "ProductIntake",
          entityId: intake.id,
          oldValue: { status: intake.status },
          newValue: {
            status: "APPROVED",
            productId: product.id,
            productCreated: !isLinkingExisting,
            countId: count.id,
          },
        },
        tx,
      );

      // 9. Mark the intake approved.
      const updatedIntake = await tx.productIntake.update({
        where: { id: intake.id },
        data: {
          status: "APPROVED",
          decidedById: params.actorUserId,
          decidedAt: new Date(),
          approvedProductId: product.id,
        },
      });

      return { intake: updatedIntake, product, count };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ApiError("CONFLICT", "A conflicting product/barcode/location record already exists.");
    }
    throw error;
  }

  // recalculateProductLocation takes a plain prisma client (not a tx client),
  // so it must run after the transaction commits rather than inside it.
  await recalculateProductLocation({
    organizationId: params.organizationId,
    warehouseId: location.warehouseId,
    productId: txResult.product.id,
    locationId: intake.locationId,
  });

  return txResult;
}
