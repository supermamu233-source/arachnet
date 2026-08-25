import { z } from "zod";
import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { authenticateRobot } from "@/server/auth/robot-auth";
import { ingestObservation } from "@/server/services/robot-observations";

const observationSchema = z.object({
  eventId: z.string().min(1),
  capturedAt: z.string().datetime({ message: "capturedAt debe ser un timestamp ISO 8601." }),
  locationCode: z.string().min(1),
  ean: z.string().min(1),
  boxes: z.number().int().min(0),
  looseUnits: z.number().int().min(0),
  confidence: z.number().min(0).max(1).nullable().optional(),
  evidenceIds: z.array(z.string().min(1)).min(1, "Se requiere al menos una imagen de evidencia."),
  rawPayload: z.unknown().optional(),
});

/**
 * Robot observation ingestion (product spec sections 3.8/9/15/17). No
 * business logic here — everything (idempotency, location/EAN resolution,
 * evidence validation, server-side quantity calculation, confidence
 * classification, reconciliation) lives in
 * server/services/robot-observations.ts.
 */
export async function POST(request: Request) {
  const requestId = newRequestId();
  try {
    const robotContext = await authenticateRobot(request);
    const body = observationSchema.parse(await request.json());

    const result = await ingestObservation({
      robotId: robotContext.robotId,
      organizationId: robotContext.organizationId,
      warehouseId: robotContext.warehouseId,
      eventId: body.eventId,
      capturedAt: body.capturedAt,
      locationCode: body.locationCode,
      ean: body.ean,
      boxes: body.boxes,
      looseUnits: body.looseUnits,
      confidence: body.confidence,
      evidenceIds: body.evidenceIds,
      rawPayload: body.rawPayload ?? {},
    });

    const { observation, replay } = result;

    return ok(
      {
        observationId: observation.id,
        eventId: observation.eventId,
        status: observation.status,
        confidenceLevel: observation.confidenceLevel,
        productId: observation.productId,
        locationId: observation.locationId,
        expectedQuantity: observation.expectedQuantity,
        observedQuantity: observation.observedQuantity,
        difference: observation.difference,
        replay,
      },
      requestId,
      { status: replay ? 200 : 201 },
    );
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
