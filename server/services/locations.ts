import QRCode from "qrcode";
import { Prisma } from "@/lib/generated/prisma/client";
import type { LocationType } from "@/lib/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/errors";
import { recordAudit } from "@/server/services/audit";

export interface CreateLocationParams {
  organizationId: string;
  warehouseId: string;
  parentId?: string;
  code: string;
  name: string;
  type: LocationType;
  zone?: string;
  aisle?: string;
  rack?: string;
  level?: string;
  bin?: string;
  actorUserId: string;
}

/**
 * Creates a location. If `parentId` is given it must resolve to a location
 * in the SAME warehouse and organization — a shelf can't be nested under a
 * rack that lives in a different warehouse. `[warehouseId, code]` is unique
 * per the schema; a collision surfaces as a 409 CONFLICT.
 */
export async function createLocation(params: CreateLocationParams) {
  if (params.parentId) {
    const parent = await prisma.location.findUnique({ where: { id: params.parentId } });
    if (!parent) {
      throw new ApiError("LOCATION_NOT_FOUND", "Parent location not found.");
    }
    if (parent.organizationId !== params.organizationId) {
      throw new ApiError("ORGANIZATION_MISMATCH", "Parent location does not belong to this organization.");
    }
    if (parent.warehouseId !== params.warehouseId) {
      throw new ApiError("LOCATION_NOT_FOUND", "Parent location does not belong to the same warehouse.");
    }
  }

  try {
    const location = await prisma.location.create({
      data: {
        organizationId: params.organizationId,
        warehouseId: params.warehouseId,
        parentId: params.parentId,
        code: params.code,
        name: params.name,
        type: params.type,
        zone: params.zone,
        aisle: params.aisle,
        rack: params.rack,
        level: params.level,
        bin: params.bin,
      },
    });

    await recordAudit({
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      action: "location.created",
      entityType: "Location",
      entityId: location.id,
      newValue: { code: location.code, type: location.type, warehouseId: location.warehouseId },
    });

    return location;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ApiError("CONFLICT", `A location with code "${params.code}" already exists in this warehouse.`);
    }
    throw error;
  }
}

export interface ListLocationsParams {
  organizationId: string;
  warehouseId?: string;
}

export async function listLocations(params: ListLocationsParams) {
  return prisma.location.findMany({
    where: {
      organizationId: params.organizationId,
      ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
    },
    orderBy: [{ warehouseId: "asc" }, { code: "asc" }],
  });
}

/**
 * Walks the parentId chain from a location up to its root, for breadcrumb
 * display (e.g. WAREHOUSE > ZONE > AISLE > RACK > LEVEL > BIN). Returns the
 * chain ordered root-first, with the requested location last.
 */
export async function getLocationWithAncestors(organizationId: string, locationId: string) {
  const location = await prisma.location.findUnique({ where: { id: locationId } });
  if (!location || location.organizationId !== organizationId) {
    throw new ApiError("LOCATION_NOT_FOUND", "Location not found.");
  }

  const chain = [location];
  let current = location;
  // Locations nest at most 6 deep (WAREHOUSE..BIN) by convention, but guard
  // against a corrupted/cyclic parentId chain regardless.
  const maxDepth = 50;
  for (let i = 0; i < maxDepth && current.parentId; i++) {
    const parent = await prisma.location.findUnique({ where: { id: current.parentId } });
    if (!parent) break;
    chain.push(parent);
    current = parent;
  }

  return chain.reverse();
}

export interface UpdateLocationParams {
  organizationId: string;
  locationId: string;
  actorUserId: string;
  name?: string;
  zone?: string;
  aisle?: string;
  rack?: string;
  level?: string;
  bin?: string;
  active?: boolean;
}

export async function updateLocation(params: UpdateLocationParams) {
  const existing = await prisma.location.findUnique({ where: { id: params.locationId } });
  if (!existing || existing.organizationId !== params.organizationId) {
    throw new ApiError("LOCATION_NOT_FOUND", "Location not found.");
  }

  const updated = await prisma.location.update({
    where: { id: params.locationId },
    data: {
      name: params.name,
      zone: params.zone,
      aisle: params.aisle,
      rack: params.rack,
      level: params.level,
      bin: params.bin,
      active: params.active,
    },
  });

  await recordAudit({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    action: "location.updated",
    entityType: "Location",
    entityId: updated.id,
    oldValue: existing,
    newValue: updated,
  });

  return updated;
}

/**
 * Renders a location code as a scannable QR code PNG data URL. The QR
 * payload is the bare location code string (e.g. "WH1-A03-RB-L04") — a
 * physical label scan looks that code up, it is not a URL. Kept free of any
 * DB access so it stays trivially unit-testable.
 */
export async function generateLocationQrPngDataUrl(locationCode: string): Promise<string> {
  return QRCode.toDataURL(locationCode);
}
