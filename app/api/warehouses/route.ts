import { z } from "zod";
import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireAuthContext, requireRole } from "@/server/auth/session";
import { createWarehouse, listWarehouses } from "@/server/services/warehouses";

const createSchema = z.object({
  name: z.string().min(1).max(200),
  code: z.string().min(1).max(50),
  address: z.string().max(500).optional(),
  timezone: z.string().min(1).max(100).optional(),
});

export async function GET() {
  const requestId = newRequestId();
  try {
    const context = await requireAuthContext();
    const warehouses = await listWarehouses(context.organizationId);
    return ok(warehouses, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}

export async function POST(request: Request) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("ADMIN");
    const body = createSchema.parse(await request.json());

    const warehouse = await createWarehouse({
      organizationId: context.organizationId,
      name: body.name,
      code: body.code,
      address: body.address,
      timezone: body.timezone,
      actorUserId: context.userId,
    });

    return ok(warehouse, requestId, { status: 201 });
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
