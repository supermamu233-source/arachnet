import { randomBytes } from "node:crypto";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/errors";

const ROBOT_SECRET_BYTES = 24;

/**
 * Robots are a completely separate credential class from human (better-auth
 * cookie) sessions — see server/auth/session.ts for those. A robot secret is
 * a long random token, hashed with the same `hashPassword` primitive human
 * password auth already uses (argon2 under the hood via better-auth/crypto),
 * never anything weaker.
 */
export interface ProvisionedRobotSecret {
  /** The raw secret. Shown to the operator exactly once, at creation/rotation
   * time — the caller must never persist this value anywhere, only display
   * it and discard it. */
  secret: string;
  /** The value actually persisted to RobotDevice.secretHash. */
  secretHash: string;
}

export async function provisionRobotSecret(): Promise<ProvisionedRobotSecret> {
  const secret = randomBytes(ROBOT_SECRET_BYTES).toString("hex");
  const secretHash = await hashPassword(secret);
  return { secret, secretHash };
}

export interface RobotAuthContext {
  robotId: string;
  organizationId: string;
  warehouseId: string;
}

/**
 * Authenticates a robot request from its `X-Robot-ID` / `Authorization:
 * Bearer <secret>` headers (product spec section 9). `code` is only unique
 * per-organization in the schema (`@@unique([organizationId, code])`), and a
 * robot has no way to know its own organizationId ahead of authenticating,
 * so this looks up by `code` alone across all organizations — operators are
 * expected to keep device codes effectively globally unique in practice.
 *
 * Deliberately returns the identical ROBOT_UNAUTHENTICATED error for both
 * "no such code" and "wrong secret" so a caller can't use response
 * differences to enumerate valid robot codes.
 */
export async function authenticateRobot(request: Request): Promise<RobotAuthContext> {
  const robotCode = request.headers.get("x-robot-id");
  const authHeader = request.headers.get("authorization");
  const providedSecret =
    authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : null;

  if (!robotCode || !providedSecret) {
    throw new ApiError("ROBOT_UNAUTHENTICATED", "Robot credentials are required.");
  }

  const device = await prisma.robotDevice.findFirst({ where: { code: robotCode } });
  if (!device) {
    throw new ApiError("ROBOT_UNAUTHENTICATED", "Invalid robot credentials.");
  }

  const valid = await verifyPassword({ hash: device.secretHash, password: providedSecret });
  if (!valid) {
    throw new ApiError("ROBOT_UNAUTHENTICATED", "Invalid robot credentials.");
  }

  if (device.status === "DISABLED") {
    throw new ApiError("ROBOT_DISABLED", "This robot device has been disabled.");
  }

  await prisma.robotDevice.update({
    where: { id: device.id },
    data: { lastSeenAt: new Date() },
  });

  return { robotId: device.id, organizationId: device.organizationId, warehouseId: device.warehouseId };
}

/**
 * `server/services/evidence.ts`'s createPresignedUpload/finalizeEvidence
 * (owned by another agent, not modified here) both attribute the action to a
 * real `User` row via a foreign-key-constrained `createdById`/`actorUserId`
 * column — there was no robot actor concept when those were written. Rather
 * than touch that file or the schema, robot-authenticated evidence routes
 * attribute the upload to one deterministic, lazily-created placeholder User
 * per organization representing "the automated robot pipeline". This only
 * satisfies that FK; the actually-accountable actor (which robot device) is
 * still correctly recorded via `recordAudit({ actorRobotId })` in
 * `ingestObservation`, and the RobotObservation row itself always links back
 * to the real `RobotDevice`. See docs/robot-protocol.md for the full
 * rationale.
 */
export async function getRobotPipelineUserId(organizationId: string): Promise<string> {
  const email = `robot-pipeline+${organizationId}@arachnet.internal`;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing.id;

  try {
    const created = await prisma.user.create({
      data: { email, name: "Automatización de robots", emailVerified: true },
    });
    return created.id;
  } catch {
    // Lost a race with a concurrent robot request creating the same
    // placeholder user for this organization — fetch the row it created.
    const raced = await prisma.user.findUnique({ where: { email } });
    if (raced) return raced.id;
    throw new ApiError("INTERNAL_ERROR", "Could not resolve the robot pipeline user.");
  }
}
