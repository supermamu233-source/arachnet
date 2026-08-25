import { z } from "zod";
import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireRole } from "@/server/auth/session";
import { recalculateAll } from "@/server/services/reconciliation";

const bodySchema = z.object({ warehouseId: z.string().optional() });

export async function POST(request: Request) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("MANAGER");
    const body = bodySchema.parse(await request.json().catch(() => ({})));
    const discrepancies = await recalculateAll(context.organizationId, body.warehouseId);
    return ok({ recalculated: discrepancies.length }, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
