import { z } from "zod";
import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireRole } from "@/server/auth/session";
import { approveIntake } from "@/server/services/intakes";

const productDetailsSchema = z.object({
  sku: z.string().min(1).max(100),
  name: z.string().min(1).max(300),
  category: z.string().max(150).optional(),
  brand: z.string().max(150).optional(),
  defaultUnitsPerBox: z.number().int().min(1).optional(),
});

const approveSchema = z.object({
  productDetails: productDetailsSchema.optional(),
});

/**
 * Approves a product intake — requires MANAGER+, deliberately a step above
 * the COUNTER role that can create an intake. This is the "human review"
 * gate from the product spec: a counter can capture and submit a physical
 * find, but a manager (or higher) must confirm/approve it before it becomes
 * a real catalogue product. The spec doesn't strictly forbid the same
 * person creating and approving an intake (no per-row "different actor"
 * check is enforced here), but requiring a higher role for the approval
 * action itself is the guardrail chosen for this phase.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("MANAGER");
    const { id } = await params;
    const body = approveSchema.parse(await request.json().catch(() => ({})));

    const result = await approveIntake({
      organizationId: context.organizationId,
      intakeId: id,
      actorUserId: context.userId,
      productDetails: body.productDetails,
    });

    return ok(result, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
