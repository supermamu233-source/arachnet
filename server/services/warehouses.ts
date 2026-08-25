import { Prisma } from "@/lib/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/errors";
import { recordAudit } from "@/server/services/audit";

export interface CreateWarehouseParams {
  organizationId: string;
  name: string;
  code: string;
  address?: string;
  timezone?: string;
  actorUserId: string;
}

/** Lists every warehouse belonging to the organization, most recently created first. */
export async function listWarehouses(organizationId: string) {
  return prisma.warehouse.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Creates a warehouse. `[organizationId, code]` is unique per the schema —
 * a collision surfaces as a 409 CONFLICT rather than a raw Prisma error.
 */
export async function createWarehouse(params: CreateWarehouseParams) {
  try {
    const warehouse = await prisma.warehouse.create({
      data: {
        organizationId: params.organizationId,
        name: params.name,
        code: params.code,
        address: params.address,
        timezone: params.timezone,
      },
    });

    await recordAudit({
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      action: "warehouse.created",
      entityType: "Warehouse",
      entityId: warehouse.id,
      newValue: { name: warehouse.name, code: warehouse.code },
    });

    return warehouse;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ApiError("CONFLICT", `A warehouse with code "${params.code}" already exists.`);
    }
    throw error;
  }
}
