import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/errors";
import { resolveIdempotency } from "@/lib/idempotency";
import { recordAudit } from "@/server/services/audit";
import { objectStorage } from "@/storage/s3-storage";
import { thumbKeyFor } from "@/server/services/evidence";
import type { ExportJob, Prisma } from "@/lib/generated/prisma/client";
import packageJson from "@/package.json" with { type: "json" };

const SIGNED_GET_EXPIRES_SECONDS = 5 * 60;

function assertOwnedByOrganization(callerOrganizationId: string, resourceOrganizationId: string): void {
  if (callerOrganizationId !== resourceOrganizationId) {
    throw new ApiError("ORGANIZATION_MISMATCH", "Resource does not belong to this organization.");
  }
}

export interface ExportFilter {
  warehouseId?: string;
}

export interface CreateExportJobParams {
  organizationId: string;
  filter: ExportFilter;
  idempotencyKey: string;
  requestHash: string;
  createdById: string;
}

/** Best-effort thumbnail fetch for embedding in the workbook — a missing or
 * unfetchable image never fails the export, per the spec's "where
 * practical" wording; the cell is simply left blank. */
async function tryFetchThumbnail(objectKey: string): Promise<Buffer | null> {
  try {
    return await objectStorage.getObjectBuffer(thumbKeyFor(objectKey));
  } catch {
    return null;
  }
}

async function addThumbnailToCell(
  workbook: ExcelJS.Workbook,
  worksheet: ExcelJS.Worksheet,
  objectKey: string | undefined,
  row: number,
  col: number,
) {
  if (!objectKey) return;
  const buffer = await tryFetchThumbnail(objectKey);
  if (!buffer) return;
  const imageId = workbook.addImage({ buffer: buffer as unknown as ExcelJS.Buffer, extension: "jpeg" });
  worksheet.addImage(imageId, {
    tl: { col: col - 1 + 0.1, row: row - 1 + 0.1 },
    ext: { width: 40, height: 40 },
  });
  worksheet.getRow(row).height = 32;
}

async function buildWorkbook(params: { organizationId: string; warehouseId?: string; userName: string }) {
  const { organizationId, warehouseId } = params;
  const orgWhere = { organizationId, ...(warehouseId ? { warehouseId } : {}) };

  const [organization, warehouse, counts, discrepancies] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId } }),
    warehouseId ? prisma.warehouse.findUnique({ where: { id: warehouseId } }) : Promise.resolve(null),
    prisma.inventoryCount.findMany({
      where: { ...orgWhere, status: "COMMITTED" },
      include: {
        product: true,
        location: true,
        createdBy: { select: { name: true } },
        evidence: { where: { purpose: "COUNT_IMAGE" }, take: 1 },
      },
      orderBy: { capturedAt: "desc" },
      take: 5000,
    }),
    prisma.inventoryDiscrepancy.findMany({
      where: { ...orgWhere, status: { notIn: ["RESOLVED", "DISMISSED"] } },
      include: {
        product: true,
        location: true,
        latestCount: { include: { evidence: { take: 1 } } },
      },
      take: 5000,
    }),
  ]);

  // Current authoritative expected balance per (productId, locationId),
  // matching the "latest sourceUpdatedAt wins" rule used everywhere else
  // (see domain/reconciliation and server/services/reconciliation.ts).
  const expectedBalances = await prisma.expectedStockBalance.findMany({
    where: orgWhere,
    orderBy: { sourceUpdatedAt: "desc" },
  });
  const expectedByPair = new Map<string, number>();
  for (const balance of expectedBalances) {
    const key = `${balance.productId}:${balance.locationId}`;
    if (!expectedByPair.has(key)) expectedByPair.set(key, balance.quantity);
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Arachnet";
  workbook.created = new Date();

  // --- Conteos ---
  const conteosSheet = workbook.addWorksheet("Conteos");
  conteosSheet.columns = [
    { header: "Foto", key: "foto", width: 8 },
    { header: "Referencia", key: "referencia", width: 16 },
    { header: "EAN", key: "ean", width: 16 },
    { header: "Producto", key: "producto", width: 24 },
    { header: "Categoría", key: "categoria", width: 14 },
    { header: "Variante", key: "variante", width: 14 },
    { header: "Cajas", key: "cajas", width: 8 },
    { header: "Uds/caja", key: "udsCaja", width: 10 },
    { header: "Sueltas", key: "sueltas", width: 10 },
    { header: "Total físico", key: "totalFisico", width: 12 },
    { header: "Stock sistema", key: "stockSistema", width: 13 },
    { header: "Diferencia", key: "diferencia", width: 12 },
    { header: "Nave/Zona", key: "zona", width: 10 },
    { header: "Calle", key: "calle", width: 10 },
    { header: "Nivel", key: "nivel", width: 10 },
    { header: "Observaciones", key: "observaciones", width: 24 },
    { header: "ID conteo", key: "idConteo", width: 26 },
    { header: "Fecha", key: "fecha", width: 20 },
    { header: "Contado por", key: "contadoPor", width: 18 },
  ];

  for (const count of counts) {
    const expected = expectedByPair.get(`${count.productId}:${count.locationId}`) ?? null;
    const rowIndex = conteosSheet.rowCount + 1;
    conteosSheet.addRow({
      foto: "",
      referencia: count.product.sku,
      ean: "",
      producto: count.product.name,
      categoria: count.product.category ?? "",
      variante: count.product.variant ?? "",
      cajas: count.boxes,
      udsCaja: count.unitsPerBox,
      sueltas: count.looseUnits,
      totalFisico: count.physicalQuantity,
      stockSistema: expected ?? "",
      diferencia: expected != null ? count.physicalQuantity - expected : "",
      zona: count.location.zone ?? "",
      calle: count.location.aisle ?? "",
      nivel: count.location.level ?? "",
      observaciones: count.observation ?? "",
      idConteo: count.id,
      fecha: count.capturedAt.toLocaleString("es-ES"),
      contadoPor: count.createdBy.name,
    });
    await addThumbnailToCell(workbook, conteosSheet, count.evidence[0]?.objectKey, rowIndex, 1);
  }

  // --- Resumen (aggregated per product across all its counted locations) ---
  interface ProductAgg {
    product: (typeof counts)[number]["product"];
    locationIds: Set<string>;
    countIds: Set<string>;
    latestByLocation: Map<string, number>;
    hasImage: boolean;
    latestCapturedAt: Date;
  }
  const byProduct = new Map<string, ProductAgg>();
  for (const count of counts) {
    let agg = byProduct.get(count.productId);
    if (!agg) {
      agg = {
        product: count.product,
        locationIds: new Set(),
        countIds: new Set(),
        latestByLocation: new Map(),
        hasImage: false,
        latestCapturedAt: count.capturedAt,
      };
      byProduct.set(count.productId, agg);
    }
    agg.locationIds.add(count.locationId);
    agg.countIds.add(count.id);
    if (count.evidence.length > 0) agg.hasImage = true;
    // counts are already ordered capturedAt desc, so the first one seen per
    // location is the latest for that location.
    if (!agg.latestByLocation.has(count.locationId)) {
      agg.latestByLocation.set(count.locationId, count.physicalQuantity);
    }
  }

  const resumenSheet = workbook.addWorksheet("Resumen");
  resumenSheet.columns = [
    { header: "Foto", key: "foto", width: 8 },
    { header: "Referencia", key: "referencia", width: 16 },
    { header: "EAN", key: "ean", width: 16 },
    { header: "Producto", key: "producto", width: 24 },
    { header: "Categoría", key: "categoria", width: 14 },
    { header: "Variante", key: "variante", width: 14 },
    { header: "Nº ubicaciones", key: "nUbicaciones", width: 14 },
    { header: "Nº conteos", key: "nConteos", width: 12 },
    { header: "Total físico", key: "totalFisico", width: 12 },
    { header: "Stock sistema", key: "stockSistema", width: 13 },
    { header: "Diferencia", key: "diferencia", width: 12 },
    { header: "Estado imagen", key: "estadoImagen", width: 14 },
    { header: "Estado conteo", key: "estadoConteo", width: 16 },
  ];

  for (const agg of byProduct.values()) {
    let totalFisico = 0;
    let stockSistema = 0;
    for (const [locationId, quantity] of agg.latestByLocation) {
      totalFisico += quantity;
      stockSistema += expectedByPair.get(`${agg.product.id}:${locationId}`) ?? 0;
    }
    const discrepancy = discrepancies.find((d) => d.productId === agg.product.id);
    resumenSheet.addRow({
      foto: "",
      referencia: agg.product.sku,
      ean: "",
      producto: agg.product.name,
      categoria: agg.product.category ?? "",
      variante: agg.product.variant ?? "",
      nUbicaciones: agg.locationIds.size,
      nConteos: agg.countIds.size,
      totalFisico,
      stockSistema,
      diferencia: totalFisico - stockSistema,
      estadoImagen: agg.hasImage ? "Con foto" : "Sin foto",
      estadoConteo: discrepancy?.status ?? "MATCH",
    });
  }

  // --- Incidencias ---
  const incidenciasSheet = workbook.addWorksheet("Incidencias");
  incidenciasSheet.columns = [
    { header: "Referencia", key: "referencia", width: 16 },
    { header: "Producto", key: "producto", width: 24 },
    { header: "Ubicación", key: "ubicacion", width: 16 },
    { header: "Esperado", key: "esperado", width: 12 },
    { header: "Observado", key: "observado", width: 12 },
    { header: "Diferencia", key: "diferencia", width: 12 },
    { header: "Severidad", key: "severidad", width: 12 },
    { header: "Estado", key: "estado", width: 16 },
    { header: "Evidencia", key: "evidencia", width: 30 },
    { header: "Visto por última vez", key: "visto", width: 20 },
  ];
  for (const d of discrepancies) {
    const evidenceRef = d.latestCount?.evidence[0]?.objectKey ?? "sin evidencia";
    incidenciasSheet.addRow({
      referencia: d.product.sku,
      producto: d.product.name,
      ubicacion: d.location.code,
      esperado: d.expectedQuantity ?? "",
      observado: d.observedQuantity ?? "",
      diferencia: d.difference ?? "",
      severidad: d.severity ?? "",
      estado: d.status,
      evidencia: evidenceRef,
      visto: d.lastSeenAt.toLocaleString("es-ES"),
    });
  }

  // --- Metadatos ---
  const metaSheet = workbook.addWorksheet("Metadatos");
  metaSheet.columns = [
    { header: "Campo", key: "campo", width: 24 },
    { header: "Valor", key: "valor", width: 60 },
  ];
  metaSheet.addRows([
    { campo: "Organización", valor: organization.name },
    { campo: "Almacén", valor: warehouse?.name ?? "Todos" },
    { campo: "Fecha de exportación", valor: new Date().toLocaleString("es-ES") },
    { campo: "Filtros", valor: JSON.stringify(params.warehouseId ? { warehouseId: params.warehouseId } : {}) },
    { campo: "Versión de la aplicación", valor: packageJson.version },
    { campo: "Exportado por", valor: params.userName },
    { campo: "Marca de tiempo del snapshot", valor: new Date().toISOString() },
  ]);

  return workbook;
}

export async function createExportJob(params: CreateExportJobParams): Promise<ExportJob> {
  const existing = await prisma.exportJob.findUnique({ where: { idempotencyKey: params.idempotencyKey } });
  const resolution = resolveIdempotency(existing, params.requestHash);
  if (resolution.outcome === "replay") {
    assertOwnedByOrganization(params.organizationId, resolution.record.organizationId);
    return resolution.record;
  }

  if (params.filter.warehouseId) {
    const warehouse = await prisma.warehouse.findUnique({ where: { id: params.filter.warehouseId } });
    if (!warehouse || warehouse.organizationId !== params.organizationId) {
      throw new ApiError("NOT_FOUND", "Warehouse not found.");
    }
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: params.createdById } });

  const snapshotAt = new Date();
  let job = await prisma.exportJob.create({
    data: {
      organizationId: params.organizationId,
      filterSnapshot: params.filter as Prisma.InputJsonValue,
      snapshotAt,
      status: "PENDING",
      idempotencyKey: params.idempotencyKey,
      requestHash: params.requestHash,
      createdById: params.createdById,
    },
  });

  try {
    job = await prisma.exportJob.update({ where: { id: job.id }, data: { status: "PROCESSING" } });

    const workbook = await buildWorkbook({
      organizationId: params.organizationId,
      warehouseId: params.filter.warehouseId,
      userName: user.name,
    });
    const rawBuffer = await workbook.xlsx.writeBuffer();
    const buffer = Buffer.from(rawBuffer as unknown as ArrayBuffer);

    const resultObjectKey = `org/${params.organizationId}/exports/${job.id}.xlsx`;
    await objectStorage.putObjectBuffer(
      resultObjectKey,
      buffer,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );

    job = await prisma.exportJob.update({
      where: { id: job.id },
      data: { status: "COMPLETED", resultObjectKey, completedAt: new Date() },
    });

    await recordAudit({
      organizationId: params.organizationId,
      actorUserId: params.createdById,
      action: "export.completed",
      entityType: "ExportJob",
      entityId: job.id,
      newValue: { filter: params.filter },
    });

    return job;
  } catch (error) {
    job = await prisma.exportJob.update({
      where: { id: job.id },
      data: { status: "FAILED", completedAt: new Date() },
    });
    await recordAudit({
      organizationId: params.organizationId,
      actorUserId: params.createdById,
      action: "export.failed",
      entityType: "ExportJob",
      entityId: job.id,
      newValue: { error: error instanceof Error ? error.message : "unknown error" },
    });
    throw error;
  }
}

export async function listExportJobs(organizationId: string) {
  return prisma.exportJob.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

export async function getExportJob(organizationId: string, jobId: string): Promise<ExportJob> {
  const job = await prisma.exportJob.findUnique({ where: { id: jobId } });
  if (!job) throw new ApiError("NOT_FOUND", "Export job not found.");
  assertOwnedByOrganization(organizationId, job.organizationId);
  return job;
}

export async function getExportDownloadUrl(organizationId: string, jobId: string): Promise<{ url: string }> {
  const job = await getExportJob(organizationId, jobId);
  if (!job.resultObjectKey) {
    throw new ApiError("CONFLICT", "This export is not completed yet.");
  }
  const url = await objectStorage.presignGet(job.resultObjectKey, SIGNED_GET_EXPIRES_SECONDS);
  return { url };
}
