import { z } from "zod";
import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireRole } from "@/server/auth/session";
import { getIntake, updateIntake } from "@/server/services/intakes";

const captureMethodSchema = z.enum(["BARCODE_SCANNER", "OCR", "MANUAL"]);

const updateSchema = z.object({
  locationId: z.string().min(1).optional(),
  rawEan: z.string().min(1).max(64).optional(),
  eanCaptureMethod: captureMethodSchema.optional(),
  rawSku: z.string().min(1).max(100).optional(),
  skuCaptureMethod: captureMethodSchema.optional(),
  productImageId: z.string().min(1).optional(),
  labelImageId: z.string().min(1).optional(),
  boxes: z.number().int().min(0).optional(),
  unitsPerBox: z.number().int().min(1).optional(),
  looseUnits: z.number().int().min(0).optional(),
});

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("VIEWER");
    const { id } = await params;

    const intake = await getIntake(context.organizationId, id);
    return ok(intake, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("COUNTER");
    const { id } = await params;
    const body = updateSchema.parse(await request.json());

    const intake = await updateIntake({
      organizationId: context.organizationId,
      intakeId: id,
      actorUserId: context.userId,
      ...body,
    });

    return ok(intake, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
