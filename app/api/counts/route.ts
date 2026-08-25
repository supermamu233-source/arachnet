import { z } from "zod";
import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireAuthContext, requireRole } from "@/server/auth/session";
import { listCounts, submitCount } from "@/server/services/counts";

// Deliberately does NOT accept a client-supplied `unitsPerBox` (or a raw
// `physicalQuantity`) — physicalQuantity is always derived server-side from
// the matched product's defaultUnitsPerBox via
// domain/inventory/quantity.ts::calculatePhysicalQuantity. Any such fields
// present in a request body are simply ignored by Zod's default (non-strict)
// object parsing rather than rejected, which is fine: they were never going
// to be read.
const submitSchema = z.object({
  warehouseId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  productId: z.string().min(1),
  locationId: z.string().min(1),
  boxes: z.number().int().min(0),
  looseUnits: z.number().int().min(0),
  observation: z.string().max(2000).optional(),
  evidenceAssetIds: z.array(z.string().min(1)).default([]),
  capturedAt: z.iso.datetime({ offset: true }).or(z.iso.datetime()),
  idempotencyKey: z.string().min(1),
  requestHash: z.string().min(1),
});

const listQuerySchema = z.object({
  sessionId: z.string().min(1).optional(),
  locationId: z.string().min(1).optional(),
  productId: z.string().min(1).optional(),
});

export async function GET(request: Request) {
  const requestId = newRequestId();
  try {
    const context = await requireAuthContext();
    const { searchParams } = new URL(request.url);
    const query = listQuerySchema.parse({
      sessionId: searchParams.get("sessionId") ?? undefined,
      locationId: searchParams.get("locationId") ?? undefined,
      productId: searchParams.get("productId") ?? undefined,
    });

    const counts = await listCounts({ organizationId: context.organizationId, ...query });
    return ok(counts, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}

export async function POST(request: Request) {
  const requestId = newRequestId();
  try {
    // This IS the idempotency-keyed endpoint the offline queue calls when it
    // comes back online — COUNTER is the lowest role that performs a
    // physical count in the field.
    const context = await requireRole("COUNTER");
    const body = submitSchema.parse(await request.json());

    const result = await submitCount({
      organizationId: context.organizationId,
      warehouseId: body.warehouseId,
      sessionId: body.sessionId,
      productId: body.productId,
      locationId: body.locationId,
      boxes: body.boxes,
      looseUnits: body.looseUnits,
      observation: body.observation,
      evidenceAssetIds: body.evidenceAssetIds,
      capturedAt: new Date(body.capturedAt),
      createdById: context.userId,
      idempotencyKey: body.idempotencyKey,
      requestHash: body.requestHash,
    });

    return ok(result.count, requestId, { status: result.replay ? 200 : 201 });
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
