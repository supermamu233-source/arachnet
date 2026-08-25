import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/errors";
import { resolveIdempotency } from "@/lib/idempotency";
import { recordAudit } from "@/server/services/audit";
import { recalculateProductLocation } from "@/server/services/reconciliation";
import { calculatePhysicalQuantity } from "@/domain/inventory/quantity";
import type { CountSessionType } from "@/lib/generated/prisma/enums";
import type { InventoryCount } from "@/lib/generated/prisma/client";

// MVP list cap, matching the convention in server/services/products.ts
// (PRODUCT_LIST_CAP) rather than building real pagination for this phase.
const SESSION_LIST_CAP = 200;
const COUNT_LIST_CAP = 500;

/** Every relation a caller needs to render a count without a follow-up
 * query: the matched product/location for display, and evidence for photo
 * thumbnails. Shared by every read path (submitCount's return value,
 * listCounts, getCount) so a client always gets the same shape regardless
 * of which endpoint it came from. */
const COUNT_INCLUDE = {
  product: true,
  location: true,
  evidence: true,
  createdBy: { select: { id: true, name: true } },
} as const;

export type CountWithRelations = InventoryCount & {
  product: NonNullable<Awaited<ReturnType<typeof prisma.product.findUnique>>>;
  location: NonNullable<Awaited<ReturnType<typeof prisma.location.findUnique>>>;
  evidence: Awaited<ReturnType<typeof prisma.evidenceAsset.findMany>>;
  createdBy: { id: string; name: string };
};

export interface CreateCountSessionParams {
  organizationId: string;
  warehouseId: string;
  name: string;
  type: CountSessionType;
  actorUserId: string;
}

/**
 * Creates a count session. The warehouse must belong to the caller's
 * organization — this is the same "verify the parent row's tenancy before
 * nesting a new row under it" pattern used by createLocation.
 */
export async function createCountSession(params: CreateCountSessionParams) {
  const warehouse = await prisma.warehouse.findUnique({ where: { id: params.warehouseId } });
  if (!warehouse || warehouse.organizationId !== params.organizationId) {
    throw new ApiError("NOT_FOUND", "Warehouse not found.");
  }

  const session = await prisma.inventoryCountSession.create({
    data: {
      organizationId: params.organizationId,
      warehouseId: params.warehouseId,
      name: params.name,
      type: params.type,
      status: "OPEN",
      createdById: params.actorUserId,
    },
  });

  await recordAudit({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    action: "count_session.created",
    entityType: "InventoryCountSession",
    entityId: session.id,
    newValue: { name: session.name, type: session.type, warehouseId: session.warehouseId },
  });

  return session;
}

export interface ListCountSessionsParams {
  organizationId: string;
  warehouseId?: string;
}

export async function listCountSessions(params: ListCountSessionsParams) {
  return prisma.inventoryCountSession.findMany({
    where: {
      organizationId: params.organizationId,
      ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
    },
    orderBy: { startedAt: "desc" },
    take: SESSION_LIST_CAP,
  });
}

export async function getCountSession(organizationId: string, sessionId: string) {
  const session = await prisma.inventoryCountSession.findUnique({ where: { id: sessionId } });
  if (!session || session.organizationId !== organizationId) {
    throw new ApiError("NOT_FOUND", "Count session not found.");
  }
  return session;
}

export interface SubmitCountParams {
  organizationId: string;
  warehouseId: string;
  sessionId?: string;
  productId: string;
  locationId: string;
  boxes: number;
  looseUnits: number;
  observation?: string;
  /**
   * Evidence policy: this is deliberately NOT hard-required (an empty array
   * is accepted). The product spec's primary flow always captures photos,
   * and the UI should nudge for at least one — but a fast recount to
   * confirm/correct a value moments after an initial commit, or a
   * connectivity-constrained field re-check, must still be possible without
   * forcing a photo retake. Every id that IS provided, however, is strictly
   * validated: it must resolve to a VERIFIED EvidenceAsset owned by this
   * organization, or the whole submission is rejected (422) rather than
   * silently dropping a bad reference.
   */
  evidenceAssetIds: string[];
  capturedAt: Date;
  createdById: string;
  idempotencyKey: string;
  /**
   * Computed by the caller (the route handler, from the exact validated
   * request body) — see lib/hashing.ts::computeRequestHash and, for the
   * browser-side offline queue that also produces this value before it ever
   * has a server connection, lib/client-hashing.ts. submitCount does not
   * recompute or second-guess this value; resolveIdempotency is the sole
   * arbiter of whether a given (idempotencyKey, requestHash) pair is a safe
   * replay or a genuine conflict. This mirrors the offline-first design:
   * the same requestHash must be reproducible by the client itself, offline,
   * before any request is sent, so a queued record's identity is stable
   * across retries without needing the server's help to define it.
   */
  requestHash: string;
}

export interface SubmitCountResult {
  count: CountWithRelations;
  /** True when this call was a retry of an already-committed
   * idempotencyKey — the count returned is the ORIGINAL one, nothing was
   * recomputed or re-reconciled. */
  replay: boolean;
}

/**
 * Validates that every referenced evidence id is a VERIFIED asset owned by
 * this organization. An empty list is allowed (see the evidence policy note
 * on SubmitCountParams); anything that IS listed must check out completely.
 */
async function validateEvidenceAssets(organizationId: string, evidenceAssetIds: string[]) {
  if (evidenceAssetIds.length === 0) return [];

  const assets = await prisma.evidenceAsset.findMany({ where: { id: { in: evidenceAssetIds } } });
  const byId = new Map(assets.map((asset) => [asset.id, asset]));

  for (const id of evidenceAssetIds) {
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

/**
 * Commits a physical count. This is the idempotency-keyed endpoint the
 * offline queue calls once it has a network connection and (if any photos
 * were captured) has already uploaded them to VERIFIED evidence assets.
 *
 * Order of operations matters for correctness:
 *  1. Idempotency check FIRST, before any other lookup/validation — a
 *     genuine replay must return instantly without re-validating anything
 *     that may have changed since the original commit (e.g. the product
 *     since being archived).
 *  2. Product + location lookups, scoped to the organization.
 *  3. physicalQuantity computed via calculatePhysicalQuantity, from the
 *     PRODUCT's defaultUnitsPerBox — never from a client-supplied value.
 *  4. Evidence validation.
 *  5. Row creation + audit, in a transaction.
 *  6. Reconciliation recalculation — only for a genuinely new commit.
 */
export async function submitCount(params: SubmitCountParams): Promise<SubmitCountResult> {
  const existing = await prisma.inventoryCount.findUnique({ where: { idempotencyKey: params.idempotencyKey } });
  const idempotency = resolveIdempotency(existing, params.requestHash);

  if (idempotency.outcome === "replay") {
    const original = await prisma.inventoryCount.findUnique({
      where: { id: idempotency.record.id },
      include: COUNT_INCLUDE,
    });
    if (!original) {
      // Should be unreachable (we just read this row), but keeps the
      // return type honest rather than asserting non-null.
      throw new ApiError("NOT_FOUND", "Count not found.");
    }
    return { count: original, replay: true };
  }

  const product = await prisma.product.findUnique({ where: { id: params.productId } });
  if (!product || product.organizationId !== params.organizationId) {
    throw new ApiError("PRODUCT_NOT_FOUND", "Product not found.");
  }

  const location = await prisma.location.findUnique({ where: { id: params.locationId } });
  if (!location || location.organizationId !== params.organizationId) {
    throw new ApiError("LOCATION_NOT_FOUND", "Location not found.");
  }
  if (location.warehouseId !== params.warehouseId) {
    throw new ApiError("LOCATION_NOT_FOUND", "Location does not belong to the specified warehouse.");
  }

  if (params.sessionId) {
    const session = await prisma.inventoryCountSession.findUnique({ where: { id: params.sessionId } });
    if (!session || session.organizationId !== params.organizationId || session.warehouseId !== params.warehouseId) {
      throw new ApiError("NOT_FOUND", "Count session not found.");
    }
  }

  // The ONLY place physicalQuantity may be computed — never trust a
  // client-sent total, and never trust a client-sent unitsPerBox either.
  const unitsPerBox = product.defaultUnitsPerBox;
  const physicalQuantity = calculatePhysicalQuantity({
    boxes: params.boxes,
    unitsPerBox,
    looseUnits: params.looseUnits,
  });

  await validateEvidenceAssets(params.organizationId, params.evidenceAssetIds);

  const created = await prisma.$transaction(async (tx) => {
    const count = await tx.inventoryCount.create({
      data: {
        organizationId: params.organizationId,
        warehouseId: params.warehouseId,
        sessionId: params.sessionId,
        productId: params.productId,
        locationId: params.locationId,
        boxes: params.boxes,
        unitsPerBox,
        looseUnits: params.looseUnits,
        physicalQuantity,
        observation: params.observation,
        status: "COMMITTED",
        capturedAt: params.capturedAt,
        createdById: params.createdById,
        idempotencyKey: params.idempotencyKey,
        requestHash: params.requestHash,
        evidence: { connect: params.evidenceAssetIds.map((id) => ({ id })) },
      },
      include: COUNT_INCLUDE,
    });

    await recordAudit(
      {
        organizationId: params.organizationId,
        actorUserId: params.createdById,
        action: "count.committed",
        entityType: "InventoryCount",
        entityId: count.id,
        newValue: {
          productId: count.productId,
          locationId: count.locationId,
          boxes: count.boxes,
          unitsPerBox: count.unitsPerBox,
          looseUnits: count.looseUnits,
          physicalQuantity: count.physicalQuantity,
        },
      },
      tx,
    );

    return count;
  });

  await recalculateProductLocation({
    organizationId: params.organizationId,
    warehouseId: params.warehouseId,
    productId: params.productId,
    locationId: params.locationId,
  });

  return { count: created, replay: false };
}

export interface ListCountsParams {
  organizationId: string;
  sessionId?: string;
  locationId?: string;
  productId?: string;
}

export async function listCounts(params: ListCountsParams) {
  return prisma.inventoryCount.findMany({
    where: {
      organizationId: params.organizationId,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(params.locationId ? { locationId: params.locationId } : {}),
      ...(params.productId ? { productId: params.productId } : {}),
    },
    include: COUNT_INCLUDE,
    orderBy: { capturedAt: "desc" },
    take: COUNT_LIST_CAP,
  });
}

export async function getCount(organizationId: string, countId: string): Promise<CountWithRelations> {
  const count = await prisma.inventoryCount.findUnique({ where: { id: countId }, include: COUNT_INCLUDE });
  if (!count) {
    throw new ApiError("NOT_FOUND", "Count not found.");
  }
  if (count.organizationId !== organizationId) {
    throw new ApiError("ORGANIZATION_MISMATCH", "Resource does not belong to this organization.");
  }
  return count;
}
