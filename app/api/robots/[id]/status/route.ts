import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireRole } from "@/server/auth/session";
import { getRobotStatus } from "@/server/services/robots";
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

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("VIEWER");
    const { id } = await params;

    const { robot, recentObservations } = await getRobotStatus({
      organizationId: context.organizationId,
      robotId: id,
    });

    return ok({ robot: toPublicRobot(robot), recentObservations }, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
