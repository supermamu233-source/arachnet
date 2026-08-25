import { z } from "zod";
import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireRole } from "@/server/auth/session";
import { dismissDiscrepancy } from "@/server/services/reconciliation";

const bodySchema = z.object({ notes: z.string().max(2000).optional() });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("MANAGER");
    const { id } = await params;
    const body = bodySchema.parse(await request.json().catch(() => ({})));
    const discrepancy = await dismissDiscrepancy({
      organizationId: context.organizationId,
      discrepancyId: id,
      actorUserId: context.userId,
      notes: body.notes,
    });
    return ok(discrepancy, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
