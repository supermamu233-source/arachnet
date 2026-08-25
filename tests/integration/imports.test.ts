import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { objectStorage } from "@/storage/s3-storage";
import { createWarehouse } from "@/server/services/warehouses";
import { createLocation } from "@/server/services/locations";
import { createProduct } from "@/server/services/products";
import { createImportJob, getImportErrorReportUrl } from "@/server/services/imports";
import { computeRequestHash } from "@/lib/hashing";
import { createTestOrgAndUser } from "@/tests/integration/helpers";

describe("imports service", () => {
  const createdOrganizationIds: string[] = [];

  afterAll(async () => {
    if (createdOrganizationIds.length > 0) {
      await prisma.organization.deleteMany({ where: { id: { in: createdOrganizationIds } } });
    }
    await prisma.$disconnect();
  });

  async function makeFixture() {
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

    return { organization, user, warehouse, location, product };
  }

  async function uploadCsv(organizationId: string, csv: string): Promise<string> {
    const objectKey = `org/${organizationId}/imports/uploads/${randomUUID()}`;
    await objectStorage.putObjectBuffer(objectKey, Buffer.from(csv, "utf-8"), "text/csv");
    return objectKey;
  }

  it("accepts a valid row and rejects an unresolvable product code, producing a downloadable error report", async () => {
    const { organization, user, warehouse, location, product } = await makeFixture();

    const csv = [
      "sku,location,quantity",
      `${product.sku},${location.code},50`,
      `DOES-NOT-EXIST,${location.code},10`,
    ].join("\n");
    const fileObjectKey = await uploadCsv(organization.id, csv);

    const idempotencyKey = randomUUID();
    const requestHash = computeRequestHash({ warehouseId: warehouse.id, type: "CSV", fileObjectKey });

    const job = await createImportJob({
      organizationId: organization.id,
      warehouseId: warehouse.id,
      type: "CSV",
      fileObjectKey,
      idempotencyKey,
      requestHash,
      createdById: user.id,
    });

    expect(job.status).toBe("COMPLETED");
    expect(job.rowsTotal).toBe(2);
    expect(job.rowsAccepted).toBe(1);
    expect(job.rowsRejected).toBe(1);
    expect(job.errorReportObjectKey).toBeTruthy();

    const balances = await prisma.expectedStockBalance.findMany({
      where: { organizationId: organization.id, productId: product.id, locationId: location.id },
    });
    expect(balances).toHaveLength(1);
    expect(balances[0].quantity).toBe(50);

    const errorReport = await getImportErrorReportUrl(organization.id, job.id);
    expect(errorReport.url).toBeTruthy();
  });

  it("is idempotent: same key + same payload returns the original job, no duplicate balances", async () => {
    const { organization, user, warehouse, location, product } = await makeFixture();
    const csv = `sku,location,quantity\n${product.sku},${location.code},20\n`;
    const fileObjectKey = await uploadCsv(organization.id, csv);
    const idempotencyKey = randomUUID();
    const requestHash = computeRequestHash({ warehouseId: warehouse.id, type: "CSV", fileObjectKey });

    const first = await createImportJob({
      organizationId: organization.id,
      warehouseId: warehouse.id,
      type: "CSV",
      fileObjectKey,
      idempotencyKey,
      requestHash,
      createdById: user.id,
    });

    const second = await createImportJob({
      organizationId: organization.id,
      warehouseId: warehouse.id,
      type: "CSV",
      fileObjectKey,
      idempotencyKey,
      requestHash,
      createdById: user.id,
    });

    expect(second.id).toBe(first.id);
    const balances = await prisma.expectedStockBalance.findMany({
      where: { organizationId: organization.id, productId: product.id, locationId: location.id },
    });
    expect(balances).toHaveLength(1);
  });

  it("rejects a same-key, different-payload import with a 409-mapped IDEMPOTENCY_CONFLICT", async () => {
    const { organization, user, warehouse, location, product } = await makeFixture();
    const idempotencyKey = randomUUID();
    const firstKey = await uploadCsv(organization.id, `sku,location,quantity\n${product.sku},${location.code},5\n`);

    await createImportJob({
      organizationId: organization.id,
      warehouseId: warehouse.id,
      type: "CSV",
      fileObjectKey: firstKey,
      idempotencyKey,
      requestHash: computeRequestHash({ fileObjectKey: firstKey }),
      createdById: user.id,
    });

    const secondKey = await uploadCsv(organization.id, `sku,location,quantity\n${product.sku},${location.code},999\n`);
    await expect(
      createImportJob({
        organizationId: organization.id,
        warehouseId: warehouse.id,
        type: "CSV",
        fileObjectKey: secondKey,
        idempotencyKey,
        requestHash: computeRequestHash({ fileObjectKey: secondKey }),
        createdById: user.id,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
  });

  it("supports a manual single-entry import", async () => {
    const { organization, user, warehouse, location, product } = await makeFixture();

    const job = await createImportJob({
      organizationId: organization.id,
      warehouseId: warehouse.id,
      type: "MANUAL",
      manualEntry: { code: product.sku, locationCode: location.code, quantity: 33 },
      idempotencyKey: randomUUID(),
      requestHash: computeRequestHash({ manual: true }),
      createdById: user.id,
    });

    expect(job.rowsAccepted).toBe(1);
    const balance = await prisma.expectedStockBalance.findFirst({
      where: { organizationId: organization.id, productId: product.id, locationId: location.id },
    });
    expect(balance?.quantity).toBe(33);
  });
});
