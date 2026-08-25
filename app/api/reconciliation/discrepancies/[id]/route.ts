import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireAuthContext } from "@/server/auth/session";
import { getDiscrepancy } from "@/server/services/reconciliation";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const context = await requireAuthContext();
    const { id } = await params;
    const discrepancy = await getDiscrepancy(context.organizationId, id);
    return ok(discrepancy, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
