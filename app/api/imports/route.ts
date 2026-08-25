import { z } from "zod";
import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireRole } from "@/server/auth/session";
import { createImportJob, listImportJobs } from "@/server/services/imports";

const manualEntrySchema = z.object({
  code: z.string().min(1),
  locationCode: z.string().min(1),
  quantity: z.number().int().min(0),
  sourceTimestamp: z.string().min(1).optional(),
});

const restConfigSchema = z.object({
  baseUrl: z.url(),
  bearerToken: z.string().min(1).optional(),
  productsPath: z.string().min(1).optional(),
  balancesPath: z.string().min(1).optional(),
});

const createSchema = z.object({
  warehouseId: z.string().min(1),
  type: z.enum(["CSV", "XLSX", "MANUAL", "GENERIC_REST"]),
  fileObjectKey: z.string().min(1).optional(),
  manualEntry: manualEntrySchema.optional(),
  restConfig: restConfigSchema.optional(),
  sourceName: z.string().min(1).max(200).optional(),
  idempotencyKey: z.string().min(1),
  requestHash: z.string().min(1),
});

export async function GET() {
  const requestId = newRequestId();
  try {
    const context = await requireRole("MANAGER");
    const jobs = await listImportJobs(context.organizationId);
    return ok(jobs, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}

export async function POST(request: Request) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("MANAGER");
    const body = createSchema.parse(await request.json());

    const job = await createImportJob({
      organizationId: context.organizationId,
      warehouseId: body.warehouseId,
      type: body.type,
      fileObjectKey: body.fileObjectKey,
      manualEntry: body.manualEntry,
      restConfig: body.restConfig,
      sourceName: body.sourceName,
      idempotencyKey: body.idempotencyKey,
      requestHash: body.requestHash,
      createdById: context.userId,
    });

    return ok(job, requestId, { status: 201 });
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
