import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/errors";
import { recordAudit } from "@/server/services/audit";
import { assertSameOrganization, type AuthContext } from "@/server/auth/session";
import { classifyDiscrepancyStatus } from "@/domain/reconciliation/status";
import { classifySeverity } from "@/domain/reconciliation/severity";
import type { ConfidenceLevel } from "@/domain/reconciliation/confidence";

interface ProductLocationKey {
  organizationId: string;
  warehouseId: string;
  productId: string;
  locationId: string;
}

/**
 * Recomputes the InventoryDiscrepancy row for one product-location pair from
 * scratch: the current authoritative expected balance (latest
 * sourceUpdatedAt) versus the latest accepted observation (whichever of the
 * latest committed human count or latest robot observation is more recent).
 * Never compares a location-level count against a product-wide total
 * (product principle 3.7) — both quantities here are already scoped to the
 * same productId AND locationId.
 */
export async function recalculateProductLocation(key: ProductLocationKey) {
  const { organizationId, warehouseId, productId, locationId } = key;

  const [expectedBalance, latestCount, latestRobotObservation] = await Promise.all([
    prisma.expectedStockBalance.findFirst({
      where: { organizationId, productId, locationId },
      orderBy: { sourceUpdatedAt: "desc" },
    }),
    prisma.inventoryCount.findFirst({
      where: { organizationId, productId, locationId, status: "COMMITTED" },
      orderBy: { capturedAt: "desc" },
    }),
    prisma.robotObservation.findFirst({
      where: { organizationId, productId, locationId, status: { in: ["ACCEPTED", "REVIEW_REQUIRED"] } },
      orderBy: { capturedAt: "desc" },
    }),
  ]);

  // A human count is a direct observation — always treated as fully
  // confident. A robot observation carries its own confidence classified at
  // ingestion time (domain/reconciliation/confidence.ts).
  let observedQuantity: number | null = null;
  let confidenceLevel: ConfidenceLevel | undefined;
  let latestCountId: string | null = null;
  let latestRobotObservationId: string | null = null;

  const countTime = latestCount?.capturedAt.getTime() ?? -Infinity;
  const robotTime = latestRobotObservation?.capturedAt.getTime() ?? -Infinity;

  if (latestCount && countTime >= robotTime) {
    observedQuantity = latestCount.physicalQuantity;
    confidenceLevel = "HIGH";
    latestCountId = latestCount.id;
  } else if (latestRobotObservation) {
    observedQuantity = latestRobotObservation.observedQuantity;
    confidenceLevel = latestRobotObservation.confidenceLevel;
    latestRobotObservationId = latestRobotObservation.id;
  }

  const expectedQuantity = expectedBalance?.quantity ?? null;
  const rawStatus = classifyDiscrepancyStatus({ expectedQuantity, observedQuantity, confidenceLevel });

  const difference =
    expectedQuantity != null && observedQuantity != null ? observedQuantity - expectedQuantity : null;
  const severity = difference != null ? classifySeverity(difference, expectedQuantity ?? 0) : null;

  const existing = await prisma.inventoryDiscrepancy.findUnique({
    where: { organizationId_productId_locationId: { organizationId, productId, locationId } },
  });

  // A fresh MATCH automatically resolves a previously open discrepancy,
  // retaining its history (product spec section 13). It does not touch a
  // discrepancy a human already explicitly RESOLVED or DISMISSED unless the
  // new observation diverges again, which naturally reopens it below.
  const isReopening = existing && ["RESOLVED", "DISMISSED"].includes(existing.status) && rawStatus !== "MATCH";
  const isAutoResolving = rawStatus === "MATCH" && existing && !["RESOLVED", "DISMISSED"].includes(existing.status);

  const finalStatus = rawStatus === "MATCH" ? "RESOLVED" : rawStatus;

  const now = new Date();
  const discrepancy = await prisma.inventoryDiscrepancy.upsert({
    where: { organizationId_productId_locationId: { organizationId, productId, locationId } },
    create: {
      organizationId,
      warehouseId,
      productId,
      locationId,
      latestCountId,
      latestRobotObservationId,
      expectedQuantity,
      observedQuantity,
      difference,
      severity,
      status: finalStatus,
      firstSeenAt: now,
      lastSeenAt: now,
      resolvedAt: rawStatus === "MATCH" ? now : null,
    },
    update: {
      latestCountId,
      latestRobotObservationId,
      expectedQuantity,
      observedQuantity,
      difference,
      severity,
      status: finalStatus,
      lastSeenAt: now,
      ...(isReopening ? { resolvedAt: null, resolvedById: null } : {}),
      ...(isAutoResolving ? { resolvedAt: now } : {}),
    },
  });

  if (isAutoResolving) {
    await prisma.discrepancyResolutionEvent.create({
      data: {
        discrepancyId: discrepancy.id,
        action: "auto_resolved_on_match",
        notes: "El sistema resolvió automáticamente la discrepancia porque una observación posterior coincide con el stock esperado.",
      },
    });
  }
  if (isReopening) {
    await prisma.discrepancyResolutionEvent.create({
      data: {
        discrepancyId: discrepancy.id,
        action: "reopened",
        notes: "Una nueva observación difiere del stock esperado; la discrepancia se reabrió.",
      },
    });
  }

  return discrepancy;
}

/** Finds every distinct product-location pair with at least one expected
 * balance, count, or robot observation, and recalculates each. Used by the
 * manual "recalculate" action and can be called after any import/count/robot
 * ingestion event for the specific pair it touched instead, for efficiency. */
export async function recalculateAll(organizationId: string, warehouseId?: string) {
  const [expectedPairs, countPairs, robotPairs] = await Promise.all([
    prisma.expectedStockBalance.findMany({
      where: { organizationId, ...(warehouseId ? { warehouseId } : {}) },
      select: { warehouseId: true, productId: true, locationId: true },
      distinct: ["productId", "locationId"],
    }),
    prisma.inventoryCount.findMany({
      where: { organizationId, ...(warehouseId ? { warehouseId } : {}) },
      select: { warehouseId: true, productId: true, locationId: true },
      distinct: ["productId", "locationId"],
    }),
    prisma.robotObservation.findMany({
      where: { organizationId },
      select: { productId: true, locationId: true, location: { select: { warehouseId: true } } },
      distinct: ["productId", "locationId"],
    }),
  ]);

  const pairMap = new Map<string, ProductLocationKey>();
  for (const p of expectedPairs) {
    if (!p.productId) continue;
    pairMap.set(`${p.productId}:${p.locationId}`, {
      organizationId,
      warehouseId: p.warehouseId,
      productId: p.productId,
      locationId: p.locationId,
    });
  }
  for (const p of countPairs) {
    pairMap.set(`${p.productId}:${p.locationId}`, {
      organizationId,
      warehouseId: p.warehouseId,
      productId: p.productId,
      locationId: p.locationId,
    });
  }
  for (const p of robotPairs) {
    if (!p.productId) continue;
    const key = `${p.productId}:${p.locationId}`;
    if (!pairMap.has(key)) {
      pairMap.set(key, {
        organizationId,
        warehouseId: p.location.warehouseId,
        productId: p.productId,
        locationId: p.locationId,
      });
    }
  }

  const results = [];
  for (const pair of pairMap.values()) {
    results.push(await recalculateProductLocation(pair));
  }
  return results;
}

export async function listDiscrepancies(params: {
  organizationId: string;
  warehouseId?: string;
  status?: string;
}) {
  return prisma.inventoryDiscrepancy.findMany({
    where: {
      organizationId: params.organizationId,
      ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
      ...(params.status ? { status: params.status as never } : {}),
    },
    include: { product: true, location: true },
    orderBy: [{ severity: "desc" }, { lastSeenAt: "desc" }],
  });
}

export async function getDiscrepancy(organizationId: string, discrepancyId: string) {
  const discrepancy = await prisma.inventoryDiscrepancy.findUnique({
    where: { id: discrepancyId },
    include: {
      product: true,
      location: true,
      latestCount: { include: { evidence: true, createdBy: { select: { name: true } } } },
      latestRobotObservation: { include: { evidence: true, robot: { select: { name: true } } } },
      resolvedBy: { select: { name: true } },
      resolutions: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!discrepancy) throw new ApiError("NOT_FOUND", "Discrepancy not found.");
  if (discrepancy.organizationId !== organizationId) {
    throw new ApiError("ORGANIZATION_MISMATCH", "Resource does not belong to this organization.");
  }
  return discrepancy;
}

async function requireOwnedDiscrepancy(organizationId: string, discrepancyId: string) {
  const discrepancy = await prisma.inventoryDiscrepancy.findUnique({ where: { id: discrepancyId } });
  if (!discrepancy) throw new ApiError("NOT_FOUND", "Discrepancy not found.");
  assertSameOrganization({ organizationId } as AuthContext, discrepancy.organizationId);
  return discrepancy;
}

export async function resolveDiscrepancy(params: {
  organizationId: string;
  discrepancyId: string;
  actorUserId: string;
  notes?: string;
}) {
  const discrepancy = await requireOwnedDiscrepancy(params.organizationId, params.discrepancyId);
  const updated = await prisma.inventoryDiscrepancy.update({
    where: { id: discrepancy.id },
    data: {
      status: "RESOLVED",
      resolvedAt: new Date(),
      resolvedById: params.actorUserId,
      resolutionNotes: params.notes,
    },
  });
  await prisma.discrepancyResolutionEvent.create({
    data: {
      discrepancyId: discrepancy.id,
      action: "resolved",
      notes: params.notes,
      actorUserId: params.actorUserId,
    },
  });
  await recordAudit({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    action: "discrepancy.resolved",
    entityType: "InventoryDiscrepancy",
    entityId: discrepancy.id,
    oldValue: { status: discrepancy.status },
    newValue: { status: "RESOLVED", notes: params.notes },
  });
  return updated;
}

export async function dismissDiscrepancy(params: {
  organizationId: string;
  discrepancyId: string;
  actorUserId: string;
  notes?: string;
}) {
  const discrepancy = await requireOwnedDiscrepancy(params.organizationId, params.discrepancyId);
  const updated = await prisma.inventoryDiscrepancy.update({
    where: { id: discrepancy.id },
    data: {
      status: "DISMISSED",
      resolvedAt: new Date(),
      resolvedById: params.actorUserId,
      resolutionNotes: params.notes,
    },
  });
  await prisma.discrepancyResolutionEvent.create({
    data: {
      discrepancyId: discrepancy.id,
      action: "dismissed",
      notes: params.notes,
      actorUserId: params.actorUserId,
    },
  });
  await recordAudit({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    action: "discrepancy.dismissed",
    entityType: "InventoryDiscrepancy",
    entityId: discrepancy.id,
    oldValue: { status: discrepancy.status },
    newValue: { status: "DISMISSED", notes: params.notes },
  });
  return updated;
}
