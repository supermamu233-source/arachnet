import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireAuthContext } from "@/server/auth/session";
import { listDiscrepancies } from "@/server/services/reconciliation";

export async function GET(request: Request) {
  const requestId = newRequestId();
  try {
    const context = await requireAuthContext();
    const url = new URL(request.url);
    const discrepancies = await listDiscrepancies({
      organizationId: context.organizationId,
      warehouseId: url.searchParams.get("warehouseId") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
    });
    return ok(discrepancies, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
