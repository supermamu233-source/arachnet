import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireRole } from "@/server/auth/session";
import { getExportJob } from "@/server/services/exports";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("COUNTER");
    const { id } = await params;
    const job = await getExportJob(context.organizationId, id);
    return ok(job, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
