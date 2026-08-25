import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireRole } from "@/server/auth/session";
import { getImportErrorReportUrl } from "@/server/services/imports";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("MANAGER");
    const { id } = await params;
    const result = await getImportErrorReportUrl(context.organizationId, id);
    return ok(result, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
