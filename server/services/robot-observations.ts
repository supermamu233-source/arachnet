import type { Prisma } from "@/lib/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/errors";
import { computeRequestHash } from "@/lib/hashing";
import { resolveIdempotency } from "@/lib/idempotency";
import { recordAudit } from "@/server/services/audit";
import { recalculateProductLocation } from "@/server/services/reconciliation";
import { calculatePhysicalQuantity } from "@/domain/inventory/quantity";
import { classifyConfidence } from "@/domain/reconciliation/confidence";
import { normalizeIdentifier } from "@/domain/products/ean";
import type { RobotObservation } from "@/lib/generated/prisma/client";

export interface IngestObservationParams {
  robotId: string;
  organizationId: string;
  warehouseId: string;
  eventId: string;
  capturedAt: string;
  locationCode: string;
  ean: string;
  boxes: number;
  looseUnits: number;
  confidence?: number | null;
  evidenceIds: string[];
  rawPayload: unknown;
}

export interface IngestObservationResult {
  observation: RobotObservation;
  /** True when this call was a retry of an already-processed event — the
   * observation returned is the ORIGINAL one, nothing was reprocessed. */
  replay: boolean;
}

/** Fallback unitsPerBox stored on a RobotObservation when the scanned EAN
 * doesn't match any catalog product — see the "unmatched EAN" note below.
 * Not authoritative; only used because the column is non-nullable. */
const UNMATCHED_PRODUCT_UNITS_PER_BOX = 1;

/**
 * Fields that make two ingestion requests for the SAME eventId "the same
 * logical event" for idempotency purposes. Deliberately excludes eventId
 * itself (that's the lookup key, not part of the payload being compared) and
 * any server-assigned timestamp (receivedAt) that would differ on every
 * retry even for a genuine, identical resend.
 */
function buildRequestHashInput(params: IngestObservationParams) {
  return {
    locationCode: params.locationCode,
    ean: params.ean,
    boxes: params.boxes,
    looseUnits: params.looseUnits,
    confidence: params.confidence ?? null,
    evidenceIds: params.evidenceIds,
    capturedAt: params.capturedAt,
    rawPayload: params.rawPayload ?? null,
  };
}

/**
 * Resolves a scanned EAN to a Product via an EXACT match only (product
 * principle 2.3 — never fuzzy). ProductBarcode values are not normalized at
 * write time (see server/services/products.ts), so an exact DB-level string
 * comparison alone could miss a barcode that only differs by surrounding
 * whitespace. This applies the same trim/uppercase normalization
 * `domain/products/matching.ts`'s `findExactMatches` uses for barcode
 * comparison, without needing to assemble the full CatalogEntry shape (which
 * also expects a `aliases` list — there is no alias data model in the schema
 * yet, so it would always be empty here anyway). The result is behaviorally
 * identical to running findExactMatches restricted to EAN/barcode matches.
 */
async function resolveProductByEan(organizationId: string, ean: string) {
  const normalized = normalizeIdentifier(ean);
  const barcodes = await prisma.productBarcode.findMany({
    where: { organizationId },
    select: { productId: true, value: true },
  });
  const match = barcodes.find((b) => normalizeIdentifier(b.value) === normalized);
  if (!match) return null;
  return prisma.product.findUnique({ where: { id: match.productId } });
}

/**
 * Validates that every referenced evidence id is a VERIFIED asset owned by
 * this organization. Empty list, a missing id, an unverified asset, or one
 * belonging to another organization all fail the same way — 422
 * VALIDATION_ERROR — since a robot observation must always carry evidence
 * that can actually be inspected by a human reviewer.
 */
async function validateEvidenceAssets(organizationId: string, evidenceIds: string[]) {
  if (evidenceIds.length === 0) {
    throw new ApiError("VALIDATION_ERROR", "At least one evidence image is required for a robot observation.");
  }

  const assets = await prisma.evidenceAsset.findMany({ where: { id: { in: evidenceIds } } });
  const byId = new Map(assets.map((asset) => [asset.id, asset]));

  for (const id of evidenceIds) {
    const asset = byId.get(id);
    if (!asset || asset.organizationId !== organizationId || asset.status !== "VERIFIED") {
      throw new ApiError(
        "VALIDATION_ERROR",
        `Evidence asset "${id}" was not found, is not verified, or does not belong to this organization.`,
      );
    }
  }

  return assets;
}

export async function ingestObservation(params: IngestObservationParams): Promise<IngestObservationResult> {
  const requestHash = computeRequestHash(buildRequestHashInput(params));

  const existing = await prisma.robotObservation.findUnique({
    where: { robotId_eventId: { robotId: params.robotId, eventId: params.eventId } },
  });

  const idempotency = resolveIdempotency(existing, requestHash);
  if (idempotency.outcome === "replay") {
    // Genuine retry of an already-processed event: return the original
    // result untouched. Do NOT re-validate evidence or re-run reconciliation
    // — that already happened (or was deliberately skipped) the first time.
    return { observation: idempotency.record, replay: true };
  }

  const location = await prisma.location.findFirst({
    where: { organizationId: params.organizationId, warehouseId: params.warehouseId, code: params.locationCode },
  });
  if (!location) {
    throw new ApiError("LOCATION_NOT_FOUND", `Location "${params.locationCode}" not found in this warehouse.`);
  }

  // Evidence is validated regardless of whether the EAN resolves to a known
  // product — a robot must always submit an inspectable image.
  const evidenceAssets = await validateEvidenceAssets(params.organizationId, params.evidenceIds);

  const product = await resolveProductByEan(params.organizationId, params.ean);

  const capturedAt = new Date(params.capturedAt);

  let unitsPerBox: number;
  let observedQuantity: number;
  let expectedQuantity: number | null = null;
  let confidenceLevel = classifyConfidence(params.confidence, evidenceAssets.length > 0);
  let status: "ACCEPTED" | "REVIEW_REQUIRED";

  if (product) {
    unitsPerBox = product.defaultUnitsPerBox;
    observedQuantity = calculatePhysicalQuantity({
      boxes: params.boxes,
      unitsPerBox,
      looseUnits: params.looseUnits,
    });

    const expectedBalance = await prisma.expectedStockBalance.findFirst({
      where: { organizationId: params.organizationId, productId: product.id, locationId: location.id },
      orderBy: { sourceUpdatedAt: "desc" },
    });
    expectedQuantity = expectedBalance?.quantity ?? null;

    status = confidenceLevel === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "ACCEPTED";
  } else {
    // Unmatched EAN: no product to compute an authoritative quantity or
    // expected balance against. We still record what was physically scanned
    // (never crash / never silently drop the observation) but there is
    // nothing to reconcile — a human must first identify/catalog this item.
    // unitsPerBox has no real source here (the column is non-nullable), so
    // we store 1 as a clearly-non-authoritative placeholder; observedQuantity
    // is informational only (boxes + looseUnits) and MUST NOT be read as a
    // real physical count. Forcing REVIEW_REQUIRED regardless of the raw
    // confidence value reflects that "no catalog match" always needs a human,
    // independent of how confident the robot was in what it saw.
    unitsPerBox = UNMATCHED_PRODUCT_UNITS_PER_BOX;
    observedQuantity = calculatePhysicalQuantity({
      boxes: params.boxes,
      unitsPerBox,
      looseUnits: params.looseUnits,
    });
    confidenceLevel = "REVIEW_REQUIRED";
    status = "REVIEW_REQUIRED";
  }

  const difference = expectedQuantity != null ? observedQuantity - expectedQuantity : null;

  const observation = await prisma.$transaction(async (tx) => {
    const created = await tx.robotObservation.create({
      data: {
        organizationId: params.organizationId,
        robotId: params.robotId,
        eventId: params.eventId,
        requestHash,
        productId: product?.id,
        locationId: location.id,
        barcodeObserved: params.ean,
        boxes: params.boxes,
        unitsPerBox,
        looseUnits: params.looseUnits,
        observedQuantity,
        expectedQuantity,
        difference,
        confidenceRaw: params.confidence ?? null,
        confidenceLevel,
        status,
        capturedAt,
        rawPayload: params.rawPayload as Prisma.InputJsonValue,
        evidence: { connect: params.evidenceIds.map((id) => ({ id })) },
      },
    });

    await recordAudit(
      {
        organizationId: params.organizationId,
        actorRobotId: params.robotId,
        action: "robot_observation.ingested",
        entityType: "RobotObservation",
        entityId: created.id,
        newValue: {
          status: created.status,
          confidenceLevel: created.confidenceLevel,
          productId: created.productId,
          locationId: created.locationId,
          observedQuantity: created.observedQuantity,
          expectedQuantity: created.expectedQuantity,
          difference: created.difference,
        },
      },
      tx,
    );

    return created;
  });

  // A REVIEW_REQUIRED observation (low confidence, incomplete evidence, or
  // an unmatched EAN) must never auto-correct the live discrepancy state
  // without a human reviewing it first (product principle 2.2/2.8) — so
  // reconciliation only runs for ACCEPTED observations, and only when there
  // is a real product+location pair to recalculate.
  if (status === "ACCEPTED" && product) {
    await recalculateProductLocation({
      organizationId: params.organizationId,
      warehouseId: params.warehouseId,
      productId: product.id,
      locationId: location.id,
    });
  }

  return { observation, replay: false };
}
