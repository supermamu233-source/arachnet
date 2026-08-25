import { z } from "zod";
import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireRole } from "@/server/auth/session";
import { removeMember, updateMemberRole } from "@/server/services/organization";

const patchSchema = z.object({ role: z.enum(["OWNER", "ADMIN", "MANAGER", "COUNTER", "VIEWER"]) });

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("ADMIN");
    const { id } = await params;
    const body = patchSchema.parse(await request.json());
    const membership = await updateMemberRole({
      organizationId: context.organizationId,
      membershipId: id,
      role: body.role,
      actorUserId: context.userId,
    });
    return ok(membership, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("ADMIN");
    const { id } = await params;
    await removeMember({ organizationId: context.organizationId, membershipId: id, actorUserId: context.userId });
    return ok({ removed: true }, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
