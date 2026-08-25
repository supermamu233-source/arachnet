import { z } from "zod";
import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireRole } from "@/server/auth/session";
import { createRobot, listRobots } from "@/server/services/robots";
import type { RobotDevice } from "@/lib/generated/prisma/client";

/** Never send secretHash to the browser — it's still a secret's derived
 * form and has no legitimate use client-side. Built via explicit field
 * selection (rather than a destructure-and-omit) so there's no unused
 * `secretHash` binding to trip up lint. */
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

export async function GET() {
  const requestId = newRequestId();
  try {
    const context = await requireRole("VIEWER");
    const robots = await listRobots(context.organizationId);
    return ok(robots.map(toPublicRobot), requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}

const createRobotSchema = z.object({
  warehouseId: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
});

export async function POST(request: Request) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("ADMIN");
    const body = createRobotSchema.parse(await request.json());

    const { robot, secret } = await createRobot({
      organizationId: context.organizationId,
      warehouseId: body.warehouseId,
      code: body.code,
      name: body.name,
      actorUserId: context.userId,
    });

    return ok({ robot: toPublicRobot(robot), secret }, requestId, { status: 201 });
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
