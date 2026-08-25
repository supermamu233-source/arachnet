import { randomUUID } from "node:crypto";
import * as XLSX from "xlsx";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { objectStorage } from "@/storage/s3-storage";
import { createWarehouse } from "@/server/services/warehouses";
import { createLocation } from "@/server/services/locations";
import { createProduct } from "@/server/services/products";
import { submitCount } from "@/server/services/counts";
import { createExportJob, getExportDownloadUrl } from "@/server/services/exports";
import { computeRequestHash } from "@/lib/hashing";
import { createTestOrgAndUser } from "@/tests/integration/helpers";

describe("exports service", () => {
  const createdOrganizationIds: string[] = [];

  afterAll(async () => {
    if (createdOrganizationIds.length > 0) {
      await prisma.organization.deleteMany({ where: { id: { in: createdOrganizationIds } } });
    }
    await prisma.$disconnect();
  });

  it("produces a COMPLETED export job with a downloadable workbook containing the four required sheets and Spanish headers", async () => {
    const { organization, user } = await createTestOrgAndUser("MANAGER");
    createdOrganizationIds.push(organization.id);

    const warehouse = await createWarehouse({
      organizationId: organization.id,
      name: "Test warehouse",
      code: `WH-${randomUUID().slice(0, 8)}`,
      actorUserId: user.id,
    });
    const location = await createLocation({
      organizationId: organization.id,
      warehouseId: warehouse.id,
      code: "A01",
      name: "Zone A",
      type: "ZONE",
      actorUserId: user.id,
    });
    const { product } = await createProduct({
      organizationId: organization.id,
      sku: `SKU-${randomUUID().slice(0, 8)}`,
      name: "Test product",
      defaultUnitsPerBox: 6,
      barcodes: [],
      actorUserId: user.id,
    });

    const source = await prisma.inventorySource.create({
      data: { organizationId: organization.id, type: "MANUAL", name: `manual-${randomUUID()}` },
    });
    await prisma.expectedStockBalance.create({
      data: {
        organizationId: organization.id,
        warehouseId: warehouse.id,
        productId: product.id,
        locationId: location.id,
        sourceId: source.id,
        quantity: 82,
        sourceUpdatedAt: new Date(),
      },
    });

    await submitCount({
      organizationId: organization.id,
      warehouseId: warehouse.id,
      productId: product.id,
      locationId: location.id,
      boxes: 12,
      looseUnits: 2,
      evidenceAssetIds: [],
      capturedAt: new Date(),
      createdById: user.id,
      idempotencyKey: randomUUID(),
      requestHash: computeRequestHash({ boxes: 12, looseUnits: 2 }),
    });

    const job = await createExportJob({
      organizationId: organization.id,
      filter: { warehouseId: warehouse.id },
      idempotencyKey: randomUUID(),
      requestHash: computeRequestHash({ warehouseId: warehouse.id }),
      createdById: user.id,
    });

    expect(job.status).toBe("COMPLETED");
    expect(job.resultObjectKey).toBeTruthy();

    const { url } = await getExportDownloadUrl(organization.id, job.id);
    expect(url).toBeTruthy();

    const buffer = await objectStorage.getObjectBuffer(job.resultObjectKey as string);
    const workbook = XLSX.read(buffer, { type: "buffer" });

    expect(workbook.SheetNames).toEqual(["Conteos", "Resumen", "Incidencias", "Metadatos"]);

    const conteosHeaders = XLSX.utils.sheet_to_json(workbook.Sheets["Conteos"], { header: 1 })[0];
    expect(conteosHeaders).toEqual([
      "Foto",
      "Referencia",
      "EAN",
      "Producto",
      "Categoría",
      "Variante",
      "Cajas",
      "Uds/caja",
      "Sueltas",
      "Total físico",
      "Stock sistema",
      "Diferencia",
      "Nave/Zona",
      "Calle",
      "Nivel",
      "Observaciones",
      "ID conteo",
      "Fecha",
      "Contado por",
    ]);

    const resumenHeaders = XLSX.utils.sheet_to_json(workbook.Sheets["Resumen"], { header: 1 })[0];
    expect(resumenHeaders).toEqual([
      "Foto",
      "Referencia",
      "EAN",
      "Producto",
      "Categoría",
      "Variante",
      "Nº ubicaciones",
      "Nº conteos",
      "Total físico",
      "Stock sistema",
      "Diferencia",
      "Estado imagen",
      "Estado conteo",
    ]);

    const conteosRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets["Conteos"]);
    expect(conteosRows).toHaveLength(1);
    expect(conteosRows[0]["Total físico"]).toBe(74);
    expect(conteosRows[0]["Stock sistema"]).toBe(82);
    expect(conteosRows[0]["Diferencia"]).toBe(-8);
  });

  it("is idempotent: same key + same filter returns the same job, no second workbook generated", async () => {
    const { organization, user } = await createTestOrgAndUser("MANAGER");
    createdOrganizationIds.push(organization.id);

    const idempotencyKey = randomUUID();
    const requestHash = computeRequestHash({});

    const first = await createExportJob({
      organizationId: organization.id,
      filter: {},
      idempotencyKey,
      requestHash,
      createdById: user.id,
    });
    const second = await createExportJob({
      organizationId: organization.id,
      filter: {},
      idempotencyKey,
      requestHash,
      createdById: user.id,
    });

    expect(second.id).toBe(first.id);
    const jobs = await prisma.exportJob.findMany({ where: { idempotencyKey } });
    expect(jobs).toHaveLength(1);
  });
});
