import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/errors";
import { resolveIdempotency } from "@/lib/idempotency";
import { recordAudit } from "@/server/services/audit";
import { getProductLookup } from "@/server/services/products";
import { objectStorage } from "@/storage/s3-storage";
import type { ImportJob } from "@/lib/generated/prisma/client";
import type { ImportType, InventorySourceType } from "@/lib/generated/prisma/enums";
import type { BalanceBatchItem, InventorySourceAdapter } from "@/domain/imports/adapter";
import { CsvAdapter } from "@/domain/imports/csv-adapter";
import { XlsxAdapter } from "@/domain/imports/xlsx-adapter";
import { ManualAdapter, type ManualBalanceEntry } from "@/domain/imports/manual-adapter";
import { GenericRestAdapter, type GenericRestConfig } from "@/domain/imports/generic-rest-adapter";
import type { RowValidationError } from "@/domain/imports/sheet-parsing";

/**
 * KNOWN LIMITATION: there is no background job queue anywhere in this
 * codebase yet. Every import is processed synchronously, inside the same
 * request that creates the `ImportJob` — fine for MVP file sizes, but a
 * large CSV/XLSX or a slow/paginated Generic REST source will hold the HTTP
 * request open for the whole duration. A future iteration should move the
 * PENDING -> PROCESSING transition into an actual async worker and have the
 * create-job endpoint return immediately with status PENDING.
 */

const SIGNED_GET_EXPIRES_SECONDS = 5 * 60;

/** Import source files (CSV/XLSX) are a different size class than evidence
 * photos — kept as its own constant rather than reusing
 * `env.MAX_UPLOAD_BYTES` (which is sized for photo uploads). */
const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;

const ALLOWED_IMPORT_CONTENT_TYPES = [
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream",
] as const;

/** Same pattern as `server/auth/session.ts`'s `assertSameOrganization` /
 * `server/services/evidence.ts`'s private copy — every function here only
 * ever receives the caller's `organizationId` string, not a full
 * `AuthContext`. */
function assertOwnedByOrganization(callerOrganizationId: string, resourceOrganizationId: string): void {
  if (callerOrganizationId !== resourceOrganizationId) {
    throw new ApiError("ORGANIZATION_MISMATCH", "Resource does not belong to this organization.");
  }
}

function defaultSourceName(type: ImportType): string {
  switch (type) {
    case "CSV":
      return "Importación CSV";
    case "XLSX":
      return "Importación XLSX";
    case "MANUAL":
      return "Entrada manual";
    case "GENERIC_REST":
      return "Fuente REST genérica";
  }
}

function mapImportTypeToSourceType(type: ImportType): InventorySourceType {
  switch (type) {
    case "CSV":
      return "CSV";
    case "XLSX":
      return "XLSX";
    case "MANUAL":
      return "MANUAL";
    case "GENERIC_REST":
      // No dedicated InventorySourceType exists for "generic REST" — ERP is
      // the closest existing bucket. The InventorySource's own `name` field
      // (user-provided or defaulted above) is what actually distinguishes
      // sources in the UI, this enum value is a coarse category only.
      return "ERP";
  }
}

function escapeCsvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function buildErrorReportCsv(rows: RowValidationError[]): Buffer {
  const lines = ["Fila,Motivo", ...rows.map((row) => `${row.rowNumber},${escapeCsvField(row.reason)}`)];
  return Buffer.from(lines.join("\n"), "utf-8");
}

export interface CreateImportJobParams {
  organizationId: string;
  warehouseId: string;
  type: ImportType;
  /** Required for type CSV/XLSX — the object key of the already-uploaded
   * source file (see `presignImportUpload`). */
  fileObjectKey?: string;
  /** Required for type MANUAL. */
  manualEntry?: ManualBalanceEntry;
  /** Required for type GENERIC_REST. */
  restConfig?: GenericRestConfig;
  /** Name for the InventorySource this import is tagged with. Defaults to a
   * type-derived name; `InventorySource` is upserted on
   * (organizationId, name) so repeated imports of the same named source
   * reuse one row. */
  sourceName?: string;
  idempotencyKey: string;
  requestHash: string;
  createdById: string;
}

function buildAdapter(params: CreateImportJobParams, fileBuffer?: Buffer): InventorySourceAdapter {
  switch (params.type) {
    case "CSV": {
      if (!fileBuffer) throw new ApiError("VALIDATION_ERROR", "A CSV import requires fileObjectKey.");
      return new CsvAdapter(fileBuffer);
    }
    case "XLSX": {
      if (!fileBuffer) throw new ApiError("VALIDATION_ERROR", "An XLSX import requires fileObjectKey.");
      return new XlsxAdapter(fileBuffer);
    }
    case "MANUAL": {
      if (!params.manualEntry) throw new ApiError("VALIDATION_ERROR", "A manual import requires manualEntry.");
      return new ManualAdapter(params.manualEntry);
    }
    case "GENERIC_REST": {
      if (!params.restConfig) throw new ApiError("VALIDATION_ERROR", "A generic REST import requires restConfig.");
      return new GenericRestAdapter(params.restConfig);
    }
  }
}

function getFormatRejections(adapter: InventorySourceAdapter): RowValidationError[] {
  if (adapter instanceof CsvAdapter || adapter instanceof XlsxAdapter || adapter instanceof GenericRestAdapter) {
    return adapter.getFormatRejections();
  }
  return [];
}

function getRowsTotal(adapter: InventorySourceAdapter, rawItemCount: number, formatRejectionCount: number): number {
  if (adapter instanceof CsvAdapter || adapter instanceof XlsxAdapter) {
    return adapter.getRowsTotal();
  }
  // ManualAdapter (1 item, never rejected at this level) and
  // GenericRestAdapter (paginated) both report every item they ever
  // produced, accepted or format-rejected.
  return rawItemCount + formatRejectionCount;
}

/** Pagination cap purely as a defensive guard against a misbehaving adapter
 * that never returns an undefined nextCursor. */
const MAX_PAGES = 1000;

async function collectAllBalanceItems(adapter: InventorySourceAdapter): Promise<BalanceBatchItem[]> {
  const all: BalanceBatchItem[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await adapter.fetchExpectedBalances(cursor);
    all.push(...page.items);
    cursor = page.nextCursor;
    pages += 1;
    if (pages > MAX_PAGES) {
      throw new Error(`Generic source exceeded ${MAX_PAGES} pages without finishing pagination.`);
    }
  } while (cursor);
  return all;
}

interface ResolvedBalance {
  productId: string;
  locationId: string;
  quantity: number;
  sourceReference?: string;
  sourceUpdatedAt: Date;
}

/**
 * Resolves each format-valid balance item's product/location codes against
 * the real catalogue (exact match only — see `getProductLookup` and product
 * principle 2.3). A row whose code doesn't resolve is REJECTED here, never
 * fuzzy-matched or silently dropped from the count.
 */
async function resolveBalanceItems(params: {
  organizationId: string;
  warehouseId: string;
  items: BalanceBatchItem[];
}): Promise<{ accepted: ResolvedBalance[]; rejected: RowValidationError[] }> {
  const accepted: ResolvedBalance[] = [];
  const rejected: RowValidationError[] = [];

  for (const [index, item] of params.items.entries()) {
    const rowNumber = item.rowNumber ?? index + 1;

    let product;
    try {
      product = await getProductLookup({ organizationId: params.organizationId, code: item.externalProductCode });
    } catch (error) {
      if (error instanceof ApiError && error.code === "PRODUCT_NOT_FOUND") {
        rejected.push({ rowNumber, reason: `Código de producto no encontrado: "${item.externalProductCode}".` });
        continue;
      }
      throw error;
    }

    const location = await prisma.location.findUnique({
      where: { warehouseId_code: { warehouseId: params.warehouseId, code: item.locationCode } },
    });
    if (!location || location.organizationId !== params.organizationId) {
      rejected.push({ rowNumber, reason: `Código de ubicación no encontrado: "${item.locationCode}".` });
      continue;
    }

    const sourceUpdatedAt = new Date(item.sourceTimestamp);
    if (Number.isNaN(sourceUpdatedAt.getTime())) {
      rejected.push({ rowNumber, reason: `Marca de tiempo inválida: "${item.sourceTimestamp}".` });
      continue;
    }

    accepted.push({
      productId: product.id,
      locationId: location.id,
      quantity: item.quantity,
      sourceReference: item.externalId,
      sourceUpdatedAt,
    });
  }

  return { accepted, rejected };
}

export async function createImportJob(params: CreateImportJobParams): Promise<ImportJob> {
  const existing = await prisma.importJob.findUnique({ where: { idempotencyKey: params.idempotencyKey } });
  const resolution = resolveIdempotency(existing, params.requestHash);
  if (resolution.outcome === "replay") {
    assertOwnedByOrganization(params.organizationId, resolution.record.organizationId);
    return resolution.record;
  }

  const warehouse = await prisma.warehouse.findUnique({ where: { id: params.warehouseId } });
  if (!warehouse || warehouse.organizationId !== params.organizationId) {
    throw new ApiError("NOT_FOUND", "Warehouse not found.");
  }

  const sourceName = params.sourceName?.trim() || defaultSourceName(params.type);
  const source = await prisma.inventorySource.upsert({
    where: { organizationId_name: { organizationId: params.organizationId, name: sourceName } },
    update: {},
    create: {
      organizationId: params.organizationId,
      name: sourceName,
      type: mapImportTypeToSourceType(params.type),
      active: true,
    },
  });

  let job = await prisma.importJob.create({
    data: {
      organizationId: params.organizationId,
      type: params.type,
      status: "PENDING",
      objectKey: params.fileObjectKey,
      idempotencyKey: params.idempotencyKey,
      requestHash: params.requestHash,
      createdById: params.createdById,
    },
  });

  try {
    job = await prisma.importJob.update({ where: { id: job.id }, data: { status: "PROCESSING" } });

    const fileBuffer =
      params.type === "CSV" || params.type === "XLSX"
        ? await (async () => {
            if (!params.fileObjectKey) {
              throw new ApiError("VALIDATION_ERROR", `A ${params.type} import requires fileObjectKey.`);
            }
            return objectStorage.getObjectBuffer(params.fileObjectKey);
          })()
        : undefined;

    const adapter = buildAdapter(params, fileBuffer);
    await adapter.validateConfiguration();

    const rawItems = await collectAllBalanceItems(adapter);
    const formatRejections = getFormatRejections(adapter);

    const { accepted, rejected: resolutionRejections } = await resolveBalanceItems({
      organizationId: params.organizationId,
      warehouseId: params.warehouseId,
      items: rawItems,
    });

    if (accepted.length > 0) {
      await prisma.expectedStockBalance.createMany({
        data: accepted.map((row) => ({
          organizationId: params.organizationId,
          warehouseId: params.warehouseId,
          productId: row.productId,
          locationId: row.locationId,
          sourceId: source.id,
          quantity: row.quantity,
          sourceReference: row.sourceReference,
          sourceUpdatedAt: row.sourceUpdatedAt,
          importJobId: job.id,
        })),
      });
    }

    const allRejections = [...formatRejections, ...resolutionRejections].sort(
      (a, b) => a.rowNumber - b.rowNumber,
    );
    const rowsTotal = getRowsTotal(adapter, rawItems.length, formatRejections.length);

    let errorReportObjectKey: string | undefined;
    if (allRejections.length > 0) {
      errorReportObjectKey = `org/${params.organizationId}/imports/${job.id}/errors.csv`;
      await objectStorage.putObjectBuffer(errorReportObjectKey, buildErrorReportCsv(allRejections), "text/csv");
    }

    job = await prisma.importJob.update({
      where: { id: job.id },
      data: {
        status: "COMPLETED",
        rowsTotal,
        rowsAccepted: accepted.length,
        rowsRejected: allRejections.length,
        errorReportObjectKey,
        completedAt: new Date(),
      },
    });

    // Per the product spec, this must never write back to the external
    // system — GenericRestAdapter's implementation (the only adapter that
    // defines it) is a local no-op.
    await adapter.acknowledgeImport?.({
      importJobId: job.id,
      rowsTotal,
      rowsAccepted: accepted.length,
      rowsRejected: allRejections.length,
    });

    await recordAudit({
      organizationId: params.organizationId,
      actorUserId: params.createdById,
      action: "import.completed",
      entityType: "ImportJob",
      entityId: job.id,
      newValue: { status: job.status, rowsTotal, rowsAccepted: accepted.length, rowsRejected: allRejections.length },
    });

    return job;
  } catch (error) {
    job = await prisma.importJob.update({
      where: { id: job.id },
      data: { status: "FAILED", completedAt: new Date() },
    });
    await recordAudit({
      organizationId: params.organizationId,
      actorUserId: params.createdById,
      action: "import.failed",
      entityType: "ImportJob",
      entityId: job.id,
      newValue: { status: "FAILED", error: error instanceof Error ? error.message : "unknown error" },
    });
    throw error;
  }
}

export async function listImportJobs(organizationId: string) {
  return prisma.importJob.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

export async function getImportJob(organizationId: string, jobId: string): Promise<ImportJob> {
  const job = await prisma.importJob.findUnique({ where: { id: jobId } });
  if (!job) throw new ApiError("NOT_FOUND", "Import job not found.");
  assertOwnedByOrganization(organizationId, job.organizationId);
  return job;
}

export async function getImportErrorReportUrl(
  organizationId: string,
  jobId: string,
): Promise<{ url: string } | { url: null; message: string }> {
  const job = await getImportJob(organizationId, jobId);
  if (!job.errorReportObjectKey || !job.rowsRejected) {
    return { url: null, message: "This import has no rejected rows, so there is no error report." };
  }
  const url = await objectStorage.presignGet(job.errorReportObjectKey, SIGNED_GET_EXPIRES_SECONDS);
  return { url };
}

export interface PresignImportUploadParams {
  organizationId: string;
  contentType: string;
  createdById: string;
}

export async function presignImportUpload(
  params: PresignImportUploadParams,
): Promise<{ uploadUrl: string; objectKey: string }> {
  if (!(ALLOWED_IMPORT_CONTENT_TYPES as readonly string[]).includes(params.contentType)) {
    throw new ApiError(
      "VALIDATION_ERROR",
      `Content type "${params.contentType}" is not accepted for import file uploads.`,
    );
  }

  const objectKey = `org/${params.organizationId}/imports/uploads/${randomUUID()}`;
  const { url } = await objectStorage.presignPut(objectKey, params.contentType, MAX_IMPORT_FILE_BYTES);
  return { uploadUrl: url, objectKey };
}
