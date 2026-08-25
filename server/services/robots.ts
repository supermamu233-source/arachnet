import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/errors";
import { recordAudit } from "@/server/services/audit";
import { provisionRobotSecret } from "@/server/auth/robot-auth";
import type { RobotDevice } from "@/lib/generated/prisma/client";

/**
 * Human-managed robot administration (product spec sections 3.8/9). Every
 * function here is called from routes that require an ADMIN+ human session
 * via `requireRole` — see server/auth/session.ts. Robot authentication
 * itself lives in server/auth/robot-auth.ts and is a separate credential
 * class entirely.
 */

export async function listRobots(organizationId: string): Promise<RobotDevice[]> {
  return prisma.robotDevice.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
  });
}

interface CreateRobotParams {
  organizationId: string;
  warehouseId: string;
  code: string;
  name: string;
  actorUserId: string;
}

export async function createRobot(
  params: CreateRobotParams,
): Promise<{ robot: RobotDevice; secret: string }> {
  const existing = await prisma.robotDevice.findUnique({
    where: { organizationId_code: { organizationId: params.organizationId, code: params.code } },
  });
  if (existing) {
    throw new ApiError("CONFLICT", "A robot with this code already exists in this organization.");
  }

  const { secret, secretHash } = await provisionRobotSecret();

  const robot = await prisma.robotDevice.create({
    data: {
      organizationId: params.organizationId,
      warehouseId: params.warehouseId,
      code: params.code,
      name: params.name,
      secretHash,
      status: "ACTIVE",
    },
  });

  await recordAudit({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    action: "robot.created",
    entityType: "RobotDevice",
    entityId: robot.id,
    newValue: { code: robot.code, name: robot.name, warehouseId: robot.warehouseId },
  });

  return { robot, secret };
}

interface RotateRobotSecretParams {
  organizationId: string;
  robotId: string;
  actorUserId: string;
}

async function requireOwnedRobot(organizationId: string, robotId: string): Promise<RobotDevice> {
  const robot = await prisma.robotDevice.findUnique({ where: { id: robotId } });
  if (!robot) {
    throw new ApiError("NOT_FOUND", "Robot not found.");
  }
  if (robot.organizationId !== organizationId) {
    throw new ApiError("ORGANIZATION_MISMATCH", "Resource does not belong to this organization.");
  }
  return robot;
}

export async function rotateRobotSecret(
  params: RotateRobotSecretParams,
): Promise<{ secret: string }> {
  const robot = await requireOwnedRobot(params.organizationId, params.robotId);
  const { secret, secretHash } = await provisionRobotSecret();

  await prisma.robotDevice.update({
    where: { id: robot.id },
    data: { secretHash },
  });

  await recordAudit({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    action: "robot.secret_rotated",
    entityType: "RobotDevice",
    entityId: robot.id,
  });

  return { secret };
}

interface DisableRobotParams {
  organizationId: string;
  robotId: string;
  actorUserId: string;
}

export async function disableRobot(params: DisableRobotParams): Promise<RobotDevice> {
  const robot = await requireOwnedRobot(params.organizationId, params.robotId);

  const updated = await prisma.robotDevice.update({
    where: { id: robot.id },
    data: { status: "DISABLED" },
  });

  await recordAudit({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    action: "robot.disabled",
    entityType: "RobotDevice",
    entityId: robot.id,
    oldValue: { status: robot.status },
    newValue: { status: "DISABLED" },
  });

  return updated;
}

export async function getRobotStatus(params: { organizationId: string; robotId: string }) {
  const robot = await requireOwnedRobot(params.organizationId, params.robotId);

  const recentObservations = await prisma.robotObservation.findMany({
    where: { robotId: robot.id },
    orderBy: { capturedAt: "desc" },
    take: 20,
    include: {
      product: { select: { name: true, sku: true } },
      location: { select: { code: true, name: true } },
    },
  });

  return { robot, recentObservations };
}
