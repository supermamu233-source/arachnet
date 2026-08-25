import { z } from "zod";
import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireRole } from "@/server/auth/session";
import { createIntake, listIntakes } from "@/server/services/intakes";

const captureMethodSchema = z.enum(["BARCODE_SCANNER", "OCR", "MANUAL"]);
const statusSchema = z.enum([
  "DRAFT",
  "READY_FOR_REVIEW",
  "MATCHED_EXISTING",
  "APPROVED",
  "REJECTED",
  "CONFLICT",
]);

const createSchema = z.object({
  locationId: z.string().min(1),
  rawEan: z.string().min(1).max(64).optional(),
  eanCaptureMethod: captureMethodSchema.optional(),
  rawSku: z.string().min(1).max(100).optional(),
  skuCaptureMethod: captureMethodSchema.optional(),
  productImageId: z.string().min(1).optional(),
  labelImageId: z.string().min(1).optional(),
  boxes: z.number().int().min(0),
  unitsPerBox: z.number().int().min(1),
  looseUnits: z.number().int().min(0),
  // Generated client-side (crypto.randomUUID() + a JSON/SHA-256 hash of the
  // logical payload) — see app/(dashboard)/products/new/page.tsx.
  idempotencyKey: z.string().min(1),
  requestHash: z.string().min(1),
});

export async function GET(request: Request) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("VIEWER");
    const { searchParams } = new URL(request.url);
    const statusParam = searchParams.get("status") ?? undefined;
    const status = statusParam ? statusSchema.parse(statusParam) : undefined;

    const intakes = await listIntakes({ organizationId: context.organizationId, status });
    return ok(intakes, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}

export async function POST(request: Request) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("COUNTER");
    const body = createSchema.parse(await request.json());

    const result = await createIntake({
      organizationId: context.organizationId,
      locationId: body.locationId,
      rawEan: body.rawEan,
      eanCaptureMethod: body.eanCaptureMethod,
      rawSku: body.rawSku,
      skuCaptureMethod: body.skuCaptureMethod,
      productImageId: body.productImageId,
      labelImageId: body.labelImageId,
      boxes: body.boxes,
      unitsPerBox: body.unitsPerBox,
      looseUnits: body.looseUnits,
      createdById: context.userId,
      idempotencyKey: body.idempotencyKey,
      requestHash: body.requestHash,
    });

    return ok(result, requestId, { status: result.replay ? 200 : 201 });
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
