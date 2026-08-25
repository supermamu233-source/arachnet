import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireAuthContext } from "@/server/auth/session";
import { getCount } from "@/server/services/counts";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const context = await requireAuthContext();
    const { id } = await params;

    const count = await getCount(context.organizationId, id);
    return ok(count, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
