import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireRole } from "@/server/auth/session";
import { listMembers } from "@/server/services/organization";

export async function GET() {
  const requestId = newRequestId();
  try {
    const context = await requireRole("ADMIN");
    const members = await listMembers(context.organizationId);
    return ok(members, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
