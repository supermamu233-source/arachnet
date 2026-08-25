import { z } from "zod";
import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { authenticateRobot, getRobotPipelineUserId } from "@/server/auth/robot-auth";
import { finalizeEvidence } from "@/server/services/evidence";

/**
 * Robot-authenticated counterpart to /api/evidence/finalize. Without this
 * route a robot could presign and upload an image but could never mark it
 * VERIFIED (the human finalize route only accepts a better-auth session),
 * meaning it could never satisfy the observation endpoint's "evidence must
 * be VERIFIED" requirement. See server/auth/robot-auth.ts for why this
 * attributes the finalize action to a per-organization placeholder "robot
 * pipeline" user rather than a real human.
 */
const finalizeSchema = z.object({
  assetId: z.string().min(1),
});

export async function POST(request: Request) {
  const requestId = newRequestId();
  try {
    const robotContext = await authenticateRobot(request);
    const body = finalizeSchema.parse(await request.json());

    const actorUserId = await getRobotPipelineUserId(robotContext.organizationId);

    const asset = await finalizeEvidence({
      organizationId: robotContext.organizationId,
      assetId: body.assetId,
      actorUserId,
    });

    return ok(asset, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
