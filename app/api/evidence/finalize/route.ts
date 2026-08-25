import { z } from "zod";
import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireRole } from "@/server/auth/session";
import { finalizeEvidence } from "@/server/services/evidence";

const finalizeSchema = z.object({
  assetId: z.string().min(1),
});

export async function POST(request: Request) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("COUNTER");
    const body = finalizeSchema.parse(await request.json());

    const asset = await finalizeEvidence({
      organizationId: context.organizationId,
      assetId: body.assetId,
      actorUserId: context.userId,
    });

    return ok(asset, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
