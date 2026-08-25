import { z } from "zod";
import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireRole } from "@/server/auth/session";
import { rejectIntake } from "@/server/services/intakes";

const rejectSchema = z.object({
  notes: z.string().max(2000).optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("MANAGER");
    const { id } = await params;
    const body = rejectSchema.parse(await request.json().catch(() => ({})));

    const intake = await rejectIntake({
      organizationId: context.organizationId,
      intakeId: id,
      actorUserId: context.userId,
      notes: body.notes,
    });

    return ok(intake, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
