import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireRole } from "@/server/auth/session";
import { listAuditLog } from "@/server/services/organization";

export async function GET(request: Request) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("ADMIN");
    const url = new URL(request.url);
    const entries = await listAuditLog({
      organizationId: context.organizationId,
      entityType: url.searchParams.get("entityType") ?? undefined,
    });
    return ok(entries, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
