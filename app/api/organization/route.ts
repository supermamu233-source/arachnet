import { z } from "zod";
import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireAuthContext, requireRole } from "@/server/auth/session";
import { getOrganization, updateOrganization } from "@/server/services/organization";

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  timezone: z.string().min(1).max(100).optional(),
  locale: z.string().min(2).max(10).optional(),
});

export async function GET() {
  const requestId = newRequestId();
  try {
    const context = await requireAuthContext();
    const organization = await getOrganization(context.organizationId);
    return ok(organization, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}

export async function PATCH(request: Request) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("ADMIN");
    const body = updateSchema.parse(await request.json());
    const organization = await updateOrganization({
      organizationId: context.organizationId,
      actorUserId: context.userId,
      ...body,
    });
    return ok(organization, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
