import { z } from "zod";
import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireAuthContext, requireRole } from "@/server/auth/session";
import { createCountSession, listCountSessions } from "@/server/services/counts";

const createSchema = z.object({
  warehouseId: z.string().min(1),
  name: z.string().min(1).max(200),
  type: z.enum(["FULL", "CYCLE", "SPOT"]).default("CYCLE"),
});

export async function GET(request: Request) {
  const requestId = newRequestId();
  try {
    const context = await requireAuthContext();
    const { searchParams } = new URL(request.url);
    const warehouseId = searchParams.get("warehouseId") ?? undefined;

    const sessions = await listCountSessions({ organizationId: context.organizationId, warehouseId });
    return ok(sessions, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}

export async function POST(request: Request) {
  const requestId = newRequestId();
  try {
    // A COUNTER starting their own cycle/spot count is a normal, expected
    // action in the field (product spec's primary flow is a counter working
    // solo) — this is deliberately lower than the MANAGER+ bar used for
    // catalog/warehouse structure changes elsewhere in the app.
    const context = await requireRole("COUNTER");
    const body = createSchema.parse(await request.json());

    const session = await createCountSession({
      organizationId: context.organizationId,
      warehouseId: body.warehouseId,
      name: body.name,
      type: body.type,
      actorUserId: context.userId,
    });

    return ok(session, requestId, { status: 201 });
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
