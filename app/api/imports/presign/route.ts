import { z } from "zod";
import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireRole } from "@/server/auth/session";
import { presignImportUpload } from "@/server/services/imports";

const bodySchema = z.object({ contentType: z.string().min(1) });

export async function POST(request: Request) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("MANAGER");
    const body = bodySchema.parse(await request.json());
    const result = await presignImportUpload({
      organizationId: context.organizationId,
      contentType: body.contentType,
      createdById: context.userId,
    });
    return ok(result, requestId, { status: 201 });
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
