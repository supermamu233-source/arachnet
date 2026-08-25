import { z } from "zod";
import { getEnv } from "@/lib/env";
import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { authenticateRobot, getRobotPipelineUserId } from "@/server/auth/robot-auth";
import { createPresignedUpload } from "@/server/services/evidence";

/**
 * Robot-authenticated counterpart to /api/evidence/presign — same request
 * and response shape, but callable with `X-Robot-ID` / `Authorization:
 * Bearer <device-secret>` headers instead of a human session cookie (see
 * server/auth/robot-auth.ts). Robots only ever upload ROBOT_IMAGE evidence.
 */
const presignSchema = z.object({
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  maxBytes: z.number().int().positive().optional(),
});

export async function POST(request: Request) {
  const requestId = newRequestId();
  try {
    const robotContext = await authenticateRobot(request);
    const body = presignSchema.parse(await request.json());
    const env = getEnv();

    const createdById = await getRobotPipelineUserId(robotContext.organizationId);

    const result = await createPresignedUpload({
      organizationId: robotContext.organizationId,
      purpose: "ROBOT_IMAGE",
      contentType: body.contentType,
      maxBytes: body.maxBytes ?? env.MAX_UPLOAD_BYTES,
      createdById,
    });

    return ok(result, requestId, { status: 201 });
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
