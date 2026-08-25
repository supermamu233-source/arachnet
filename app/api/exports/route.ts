import { z } from "zod";
import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireRole } from "@/server/auth/session";
import { createExportJob, listExportJobs } from "@/server/services/exports";

const createSchema = z.object({
  warehouseId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1),
  requestHash: z.string().min(1),
});

export async function GET() {
  const requestId = newRequestId();
  try {
    const context = await requireRole("COUNTER");
    const jobs = await listExportJobs(context.organizationId);
    return ok(jobs, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}

export async function POST(request: Request) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("COUNTER");
    const body = createSchema.parse(await request.json());

    const job = await createExportJob({
      organizationId: context.organizationId,
      filter: { warehouseId: body.warehouseId },
      idempotencyKey: body.idempotencyKey,
      requestHash: body.requestHash,
      createdById: context.userId,
    });

    return ok(job, requestId, { status: 201 });
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
