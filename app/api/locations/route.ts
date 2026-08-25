import { z } from "zod";
import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireAuthContext, requireRole } from "@/server/auth/session";
import { createLocation, listLocations } from "@/server/services/locations";

const locationTypeSchema = z.enum(["WAREHOUSE", "ZONE", "AISLE", "RACK", "LEVEL", "BIN"]);

const createSchema = z.object({
  warehouseId: z.string().min(1),
  parentId: z.string().min(1).optional(),
  code: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  type: locationTypeSchema,
  zone: z.string().max(100).optional(),
  aisle: z.string().max(100).optional(),
  rack: z.string().max(100).optional(),
  level: z.string().max(100).optional(),
  bin: z.string().max(100).optional(),
});

export async function GET(request: Request) {
  const requestId = newRequestId();
  try {
    const context = await requireAuthContext();
    const { searchParams } = new URL(request.url);
    const warehouseId = searchParams.get("warehouseId") ?? undefined;

    const locations = await listLocations({ organizationId: context.organizationId, warehouseId });
    return ok(locations, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}

export async function POST(request: Request) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("MANAGER");
    const body = createSchema.parse(await request.json());

    const location = await createLocation({
      organizationId: context.organizationId,
      warehouseId: body.warehouseId,
      parentId: body.parentId,
      code: body.code,
      name: body.name,
      type: body.type,
      zone: body.zone,
      aisle: body.aisle,
      rack: body.rack,
      level: body.level,
      bin: body.bin,
      actorUserId: context.userId,
    });

    return ok(location, requestId, { status: 201 });
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
