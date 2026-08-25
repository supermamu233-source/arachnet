import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createWarehouse } from "@/server/services/warehouses";
import { createLocation } from "@/server/services/locations";
import { createProduct } from "@/server/services/products";
import { createCountSession, submitCount } from "@/server/services/counts";
import { computeRequestHash } from "@/lib/hashing";
import { createTestOrgAndUser } from "@/tests/integration/helpers";

describe("counts service", () => {
  const createdOrganizationIds: string[] = [];

  afterAll(async () => {
    if (createdOrganizationIds.length > 0) {
      await prisma.organization.deleteMany({ where: { id: { in: createdOrganizationIds } } });
    }
    await prisma.$disconnect();
  });

  async function makeFixture() {
    const { organization, user } = await createTestOrgAndUser("COUNTER");
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

  it("computes physicalQuantity from the product's defaultUnitsPerBox, never a client-supplied value", async () => {
    const { organization, user, warehouse, location, product } = await makeFixture();

    const payload = {
      warehouseId: warehouse.id,
      productId: product.id,
      locationId: location.id,
      boxes: 12,
      looseUnits: 2,
      // A client-shaped payload might include an unrelated "unitsPerBox"
      // field (e.g. from stale local UI state) — submitCount's params type
      // doesn't even accept one, so there's nothing here to prove it's
      // ignored beyond confirming the computed value only ever reflects the
      // product's own defaultUnitsPerBox (6), not something else.
      capturedAt: new Date(),
    };
    const idempotencyKey = randomUUID();
    const requestHash = computeRequestHash(payload);

    const { count, replay } = await submitCount({
      organizationId: organization.id,
      warehouseId: warehouse.id,
      productId: product.id,
      locationId: location.id,
      boxes: 12,
      looseUnits: 2,
      evidenceAssetIds: [],
      capturedAt: payload.capturedAt,
      createdById: user.id,
      idempotencyKey,
      requestHash,
    });

    expect(replay).toBe(false);
    expect(count.unitsPerBox).toBe(6);
    expect(count.physicalQuantity).toBe(74); // 12 * 6 + 2
  });

  it("matches the required robot-integration seed case exactly (12 boxes, 2 loose, unitsPerBox 6 -> 74)", async () => {
    const { organization, user, warehouse, location, product } = await makeFixture();

    const idempotencyKey = randomUUID();
    const requestHash = computeRequestHash({ productId: product.id, boxes: 12, looseUnits: 2 });

    const { count } = await submitCount({
      organizationId: organization.id,
      warehouseId: warehouse.id,
      productId: product.id,
      locationId: location.id,
      boxes: 12,
      looseUnits: 2,
      evidenceAssetIds: [],
      capturedAt: new Date(),
      createdById: user.id,
      idempotencyKey,
      requestHash,
    });

    expect(count.physicalQuantity).toBe(74);
  });

  it("returns the original count on a same-key, same-payload replay without creating a duplicate row", async () => {
    const { organization, user, warehouse, location, product } = await makeFixture();
    const idempotencyKey = randomUUID();
    const requestHash = computeRequestHash({ productId: product.id, boxes: 5, looseUnits: 1 });
    const capturedAt = new Date();

    const first = await submitCount({
      organizationId: organization.id,
      warehouseId: warehouse.id,
      productId: product.id,
      locationId: location.id,
      boxes: 5,
      looseUnits: 1,
      evidenceAssetIds: [],
      capturedAt,
      createdById: user.id,
      idempotencyKey,
      requestHash,
    });
    expect(first.replay).toBe(false);

    const second = await submitCount({
      organizationId: organization.id,
      warehouseId: warehouse.id,
      productId: product.id,
      locationId: location.id,
      boxes: 5,
      looseUnits: 1,
      evidenceAssetIds: [],
      capturedAt,
      createdById: user.id,
      idempotencyKey,
      requestHash,
    });
    expect(second.replay).toBe(true);
    expect(second.count.id).toBe(first.count.id);

    const rows = await prisma.inventoryCount.findMany({ where: { idempotencyKey } });
    expect(rows).toHaveLength(1);
  });

  it("rejects a same-key, different-payload submission with a 409-mapped IDEMPOTENCY_CONFLICT", async () => {
    const { organization, user, warehouse, location, product } = await makeFixture();
    const idempotencyKey = randomUUID();

    await submitCount({
      organizationId: organization.id,
      warehouseId: warehouse.id,
      productId: product.id,
      locationId: location.id,
      boxes: 5,
      looseUnits: 1,
      evidenceAssetIds: [],
      capturedAt: new Date(),
      createdById: user.id,
      idempotencyKey,
      requestHash: computeRequestHash({ productId: product.id, boxes: 5, looseUnits: 1 }),
    });

    await expect(
      submitCount({
        organizationId: organization.id,
        warehouseId: warehouse.id,
        productId: product.id,
        locationId: location.id,
        boxes: 999,
        looseUnits: 999,
        evidenceAssetIds: [],
        capturedAt: new Date(),
        createdById: user.id,
        idempotencyKey,
        requestHash: computeRequestHash({ productId: product.id, boxes: 999, looseUnits: 999 }),
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
  });

  it("triggers reconciliation on commit, creating a discrepancy against the expected balance", async () => {
    const { organization, user, warehouse, location, product } = await makeFixture();

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

    const discrepancy = await prisma.inventoryDiscrepancy.findUnique({
      where: { organizationId_productId_locationId: { organizationId: organization.id, productId: product.id, locationId: location.id } },
    });
    expect(discrepancy).toBeTruthy();
    expect(discrepancy?.expectedQuantity).toBe(82);
    expect(discrepancy?.observedQuantity).toBe(74);
    expect(discrepancy?.difference).toBe(-8);
    expect(discrepancy?.status).toBe("SHORTAGE");
  });

  it("creates a count session scoped to the organization and warehouse", async () => {
    const { organization, user, warehouse } = await makeFixture();
    const session = await createCountSession({
      organizationId: organization.id,
      warehouseId: warehouse.id,
      name: "Cycle count 1",
      type: "CYCLE",
      actorUserId: user.id,
    });
    expect(session.status).toBe("OPEN");
    expect(session.warehouseId).toBe(warehouse.id);
  });
});
