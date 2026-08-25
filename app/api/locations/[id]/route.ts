import { z } from "zod";
import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireRole } from "@/server/auth/session";
import { updateLocation } from "@/server/services/locations";

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  zone: z.string().max(100).optional(),
  aisle: z.string().max(100).optional(),
  rack: z.string().max(100).optional(),
  level: z.string().max(100).optional(),
  bin: z.string().max(100).optional(),
  active: z.boolean().optional(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("MANAGER");
    const { id } = await params;
    const body = updateSchema.parse(await request.json());

    const location = await updateLocation({
      organizationId: context.organizationId,
      locationId: id,
      actorUserId: context.userId,
      ...body,
    });

    return ok(location, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
