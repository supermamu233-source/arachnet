import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireRole } from "@/server/auth/session";
import { disableRobot } from "@/server/services/robots";
import type { RobotDevice } from "@/lib/generated/prisma/client";

function toPublicRobot(robot: RobotDevice) {
  return {
    id: robot.id,
    organizationId: robot.organizationId,
    warehouseId: robot.warehouseId,
    code: robot.code,
    name: robot.name,
    status: robot.status,
    lastSeenAt: robot.lastSeenAt,
    firmwareVersion: robot.firmwareVersion,
    createdAt: robot.createdAt,
  };
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("ADMIN");
    const { id } = await params;

    const robot = await disableRobot({
      organizationId: context.organizationId,
      robotId: id,
      actorUserId: context.userId,
    });

    return ok(toPublicRobot(robot), requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
