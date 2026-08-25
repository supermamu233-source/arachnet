import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireRole } from "@/server/auth/session";
import { rotateRobotSecret } from "@/server/services/robots";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("ADMIN");
    const { id } = await params;

    const { secret } = await rotateRobotSecret({
      organizationId: context.organizationId,
      robotId: id,
      actorUserId: context.userId,
    });

    return ok({ secret }, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
