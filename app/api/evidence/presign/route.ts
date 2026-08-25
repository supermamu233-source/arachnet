import { z } from "zod";
import { getEnv } from "@/lib/env";
import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireRole } from "@/server/auth/session";
import { createPresignedUpload } from "@/server/services/evidence";

const EVIDENCE_PURPOSES = [
  "PRODUCT_IMAGE",
  "LABEL_IMAGE",
  "COUNT_IMAGE",
  "SHELF_IMAGE",
  "BARCODE_CROP",
  "ROBOT_IMAGE",
] as const;

const presignSchema = z.object({
  purpose: z.enum(EVIDENCE_PURPOSES),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  maxBytes: z.number().int().positive().optional(),
});

export async function POST(request: Request) {
  const requestId = newRequestId();
  try {
    // Any authenticated org member at COUNTER level or above may upload
    // evidence while performing a physical count.
    const context = await requireRole("COUNTER");
    const body = presignSchema.parse(await request.json());
    const env = getEnv();

    const result = await createPresignedUpload({
      organizationId: context.organizationId,
      purpose: body.purpose,
      contentType: body.contentType,
      maxBytes: body.maxBytes ?? env.MAX_UPLOAD_BYTES,
      createdById: context.userId,
    });

    return ok(result, requestId, { status: 201 });
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
