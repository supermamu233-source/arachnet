import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { computeRequestHash } from "@/lib/hashing";
import { createProduct } from "@/server/services/products";
import { approveIntake, createIntake, rejectIntake } from "@/server/services/intakes";
import { createTestOrgAndUser } from "@/tests/integration/helpers";

// A real, checksum-valid EAN-13 (see tests/unit/ean.test.ts for provenance).
const VALID_EAN13 = "4006381333931";
const OTHER_EAN13 = "5000112637922"; // also checksum-valid, different value

describe("product intake service", () => {
  const createdOrganizationIds: string[] = [];

  afterAll(async () => {
    if (createdOrganizationIds.length > 0) {
      await prisma.organization.deleteMany({ where: { id: { in: createdOrganizationIds } } });
    }
    await prisma.$disconnect();
  });

  async function makeOrgUser(role: "OWNER" | "ADMIN" | "MANAGER" | "COUNTER" | "VIEWER" = "COUNTER") {
    const { organization, user } = await createTestOrgAndUser(role);
    createdOrganizationIds.push(organization.id);
    return { organization, user };
  }

  async function makeWarehouseAndLocation(organizationId: string) {
    const suffix = randomUUID().slice(0, 8);
    const warehouse = await prisma.warehouse.create({
      data: { organizationId, name: `Warehouse ${suffix}`, code: `WH-${suffix}` },
    });
    const location = await prisma.location.create({
      data: {
        organizationId,
        warehouseId: warehouse.id,
        code: `LOC-${suffix}`,
        name: `Location ${suffix}`,
        type: "BIN",
      },
    });
    return { warehouse, location };
  }

  /** Creates a VERIFIED EvidenceAsset row directly (bypassing the real
   * presign/PUT/finalize MinIO pipeline, which is already covered by
   * tests/integration/evidence.test.ts) so intake logic can be tested in
   * isolation without depending on a running MinIO instance. */
  async function makeVerifiedEvidence(
    organizationId: string,
    purpose: "PRODUCT_IMAGE" | "LABEL_IMAGE",
    createdById: string,
  ) {
    return prisma.evidenceAsset.create({
      data: {
        organizationId,
        objectKey: `org/${organizationId}/evidence/${purpose}/${randomUUID()}.jpg`,
        purpose,
        contentType: "image/jpeg",
        status: "VERIFIED",
        actualBytes: 1024,
        sha256: randomUUID(),
        width: 800,
        height: 600,
        createdById,
        verifiedAt: new Date(),
      },
    });
  }

  function buildCreateParams(overrides: Record<string, unknown> = {}) {
    const base = {
      boxes: 3,
      unitsPerBox: 12,
      looseUnits: 5,
      rawSku: undefined,
      rawEan: undefined,
    };
    const merged = { ...base, ...overrides };
    const idempotencyKey = randomUUID();
    const requestHash = computeRequestHash(merged);
    return { merged, idempotencyKey, requestHash };
  }

  it("computes physicalQuantity as boxes*unitsPerBox+looseUnits and is idempotent on replay", async () => {
    const { organization, user } = await makeOrgUser();
    const { location } = await makeWarehouseAndLocation(organization.id);

    const { merged, idempotencyKey, requestHash } = buildCreateParams({ boxes: 4, unitsPerBox: 10, looseUnits: 7 });

    const first = await createIntake({
      organizationId: organization.id,
      locationId: location.id,
      boxes: merged.boxes,
      unitsPerBox: merged.unitsPerBox,
      looseUnits: merged.looseUnits,
      createdById: user.id,
      idempotencyKey,
      requestHash,
    });

    expect(first.replay).toBe(false);
    expect(first.intake.physicalQuantity).toBe(4 * 10 + 7);
    expect(first.intake.status).toBe("READY_FOR_REVIEW");

    // Same key + same hash => replay, same row, nothing recomputed.
    const replay = await createIntake({
      organizationId: organization.id,
      locationId: location.id,
      boxes: merged.boxes,
      unitsPerBox: merged.unitsPerBox,
      looseUnits: merged.looseUnits,
      createdById: user.id,
      idempotencyKey,
      requestHash,
    });
    expect(replay.replay).toBe(true);
    expect(replay.intake.id).toBe(first.intake.id);

    const rowCount = await prisma.productIntake.count({ where: { idempotencyKey } });
    expect(rowCount).toBe(1);
  });

  it("rejects the same idempotency key reused with a different request payload (409 IDEMPOTENCY_CONFLICT)", async () => {
    const { organization, user } = await makeOrgUser();
    const { location } = await makeWarehouseAndLocation(organization.id);
    const idempotencyKey = randomUUID();

    await createIntake({
      organizationId: organization.id,
      locationId: location.id,
      boxes: 1,
      unitsPerBox: 1,
      looseUnits: 1,
      createdById: user.id,
      idempotencyKey,
      requestHash: computeRequestHash({ boxes: 1 }),
    });

    await expect(
      createIntake({
        organizationId: organization.id,
        locationId: location.id,
        boxes: 2,
        unitsPerBox: 1,
        looseUnits: 1,
        createdById: user.id,
        idempotencyKey,
        requestHash: computeRequestHash({ boxes: 2 }),
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("yields MATCHED_EXISTING with the correct candidateProductId on an exact EAN match", async () => {
    const { organization, user } = await makeOrgUser();
    const { location } = await makeWarehouseAndLocation(organization.id);
    const { product } = await createProduct({
      organizationId: organization.id,
      sku: "SKU-MATCH-EAN",
      name: "Existing product",
      defaultUnitsPerBox: 1,
      barcodes: [{ value: VALID_EAN13, type: "EAN13" }],
      actorUserId: user.id,
    });

    const { intake } = await createIntake({
      organizationId: organization.id,
      locationId: location.id,
      rawEan: VALID_EAN13,
      eanCaptureMethod: "BARCODE_SCANNER",
      boxes: 1,
      unitsPerBox: 6,
      looseUnits: 0,
      createdById: user.id,
      idempotencyKey: randomUUID(),
      requestHash: computeRequestHash({ ean: VALID_EAN13 }),
    });

    expect(intake.status).toBe("MATCHED_EXISTING");
    expect(intake.candidateProductId).toBe(product.id);
  });

  it("yields READY_FOR_REVIEW when no exact match exists", async () => {
    const { organization, user } = await makeOrgUser();
    const { location } = await makeWarehouseAndLocation(organization.id);

    const { intake } = await createIntake({
      organizationId: organization.id,
      locationId: location.id,
      rawEan: "9999999999999",
      boxes: 1,
      unitsPerBox: 1,
      looseUnits: 0,
      createdById: user.id,
      idempotencyKey: randomUUID(),
      requestHash: computeRequestHash({ ean: "9999999999999" }),
    });

    expect(intake.status).toBe("READY_FOR_REVIEW");
    expect(intake.candidateProductId).toBeNull();
  });

  it("surfaces CONFLICT when EAN and SKU exactly match two different products", async () => {
    const { organization, user } = await makeOrgUser();
    const { location } = await makeWarehouseAndLocation(organization.id);
    const { product: byEan } = await createProduct({
      organizationId: organization.id,
      sku: "SKU-CONFLICT-A",
      name: "Product A",
      defaultUnitsPerBox: 1,
      barcodes: [{ value: OTHER_EAN13, type: "EAN13" }],
      actorUserId: user.id,
    });
    const { product: bySku } = await createProduct({
      organizationId: organization.id,
      sku: "SKU-CONFLICT-B",
      name: "Product B",
      defaultUnitsPerBox: 1,
      barcodes: [],
      actorUserId: user.id,
    });

    const { intake } = await createIntake({
      organizationId: organization.id,
      locationId: location.id,
      rawEan: OTHER_EAN13,
      rawSku: "SKU-CONFLICT-B",
      boxes: 1,
      unitsPerBox: 1,
      looseUnits: 0,
      createdById: user.id,
      idempotencyKey: randomUUID(),
      requestHash: computeRequestHash({ ean: OTHER_EAN13, sku: "SKU-CONFLICT-B" }),
    });

    expect(intake.status).toBe("CONFLICT");
    expect(intake.candidateProductId).toBe(byEan.id);
    expect(intake.decisionNotes).toContain(byEan.id);
    expect(intake.decisionNotes).toContain(bySku.id);
  });

  it("approves a READY_FOR_REVIEW intake with new product details: creates product, barcode, packaging rule, location assignment, initial count, and audit record", async () => {
    const { organization, user: counter } = await makeOrgUser("COUNTER");
    const manager = await prisma.user.create({
      data: { email: `manager-${randomUUID()}@example.test`, name: "Manager", emailVerified: true },
    });
    await prisma.membership.create({
      data: { organizationId: organization.id, userId: manager.id, role: "MANAGER" },
    });
    const { location } = await makeWarehouseAndLocation(organization.id);
    const productImage = await makeVerifiedEvidence(organization.id, "PRODUCT_IMAGE", counter.id);
    const labelImage = await makeVerifiedEvidence(organization.id, "LABEL_IMAGE", counter.id);

    const { intake } = await createIntake({
      organizationId: organization.id,
      locationId: location.id,
      rawEan: "1111111111116",
      rawSku: "NEW-SKU-1",
      productImageId: productImage.id,
      labelImageId: labelImage.id,
      boxes: 2,
      unitsPerBox: 8,
      looseUnits: 3,
      createdById: counter.id,
      idempotencyKey: randomUUID(),
      requestHash: computeRequestHash({ sku: "NEW-SKU-1" }),
    });
    expect(intake.status).toBe("READY_FOR_REVIEW");

    const result = await approveIntake({
      organizationId: organization.id,
      intakeId: intake.id,
      actorUserId: manager.id,
      productDetails: { sku: "NEW-SKU-1", name: "Brand New Product", defaultUnitsPerBox: 8 },
    });

    expect(result.intake.status).toBe("APPROVED");
    expect(result.intake.approvedProductId).toBe(result.product.id);
    expect(result.product.sku).toBe("NEW-SKU-1");
    expect(result.count.physicalQuantity).toBe(2 * 8 + 3);
    expect(result.count.status).toBe("COMMITTED");

    const barcodes = await prisma.productBarcode.findMany({ where: { productId: result.product.id } });
    const barcodeValues = barcodes.map((b) => b.value);
    expect(barcodeValues).toContain("1111111111116");
    expect(barcodeValues).toContain("NEW-SKU-1");

    const packagingRules = await prisma.packagingRule.findMany({ where: { productId: result.product.id } });
    expect(packagingRules).toHaveLength(1);
    expect(packagingRules[0].unitsContained).toBe(8);

    const productLocation = await prisma.productLocation.findUnique({
      where: { productId_locationId: { productId: result.product.id, locationId: location.id } },
    });
    expect(productLocation).not.toBeNull();

    const count = await prisma.inventoryCount.findUnique({ where: { id: result.count.id } });
    expect(count?.productId).toBe(result.product.id);
    expect(count?.locationId).toBe(location.id);

    const audit = await prisma.auditLog.findFirst({
      where: { organizationId: organization.id, entityType: "ProductIntake", entityId: intake.id, action: "product_intake.approved" },
    });
    expect(audit).not.toBeNull();

    const discrepancy = await prisma.inventoryDiscrepancy.findUnique({
      where: { organizationId_productId_locationId: { organizationId: organization.id, productId: result.product.id, locationId: location.id } },
    });
    expect(discrepancy).not.toBeNull();
  });

  it("approves a MATCHED_EXISTING intake by linking to the existing product instead of creating a duplicate", async () => {
    const { organization, user: manager } = await makeOrgUser("MANAGER");
    const { location } = await makeWarehouseAndLocation(organization.id);
    const { product: existingProduct } = await createProduct({
      organizationId: organization.id,
      sku: "SKU-LINK-EXISTING",
      name: "Existing linked product",
      defaultUnitsPerBox: 4,
      barcodes: [{ value: VALID_EAN13, type: "EAN13" }],
      actorUserId: manager.id,
    });

    const { intake } = await createIntake({
      organizationId: organization.id,
      locationId: location.id,
      rawEan: VALID_EAN13,
      boxes: 1,
      unitsPerBox: 4,
      looseUnits: 2,
      createdById: manager.id,
      idempotencyKey: randomUUID(),
      requestHash: computeRequestHash({ ean: VALID_EAN13, salt: randomUUID() }),
    });
    expect(intake.status).toBe("MATCHED_EXISTING");
    expect(intake.candidateProductId).toBe(existingProduct.id);

    const result = await approveIntake({
      organizationId: organization.id,
      intakeId: intake.id,
      actorUserId: manager.id,
    });

    expect(result.product.id).toBe(existingProduct.id);

    const productCount = await prisma.product.count({ where: { organizationId: organization.id, sku: "SKU-LINK-EXISTING" } });
    expect(productCount).toBe(1);

    const totalProducts = await prisma.product.count({ where: { organizationId: organization.id } });
    expect(totalProducts).toBe(1);
  });

  it("rejects an intake, setting REJECTED status with decision notes", async () => {
    const { organization, user: manager } = await makeOrgUser("MANAGER");
    const { location } = await makeWarehouseAndLocation(organization.id);

    const { intake } = await createIntake({
      organizationId: organization.id,
      locationId: location.id,
      boxes: 1,
      unitsPerBox: 1,
      looseUnits: 0,
      createdById: manager.id,
      idempotencyKey: randomUUID(),
      requestHash: computeRequestHash({ salt: randomUUID() }),
    });

    const rejected = await rejectIntake({
      organizationId: organization.id,
      intakeId: intake.id,
      actorUserId: manager.id,
      notes: "Not a real find, duplicate scan.",
    });

    expect(rejected.status).toBe("REJECTED");
    expect(rejected.decisionNotes).toBe("Not a real find, duplicate scan.");
    expect(rejected.decidedById).toBe(manager.id);
    expect(rejected.decidedAt).not.toBeNull();
  });

  it("rejects approving an already-APPROVED intake with a clear error", async () => {
    const { organization, user: manager } = await makeOrgUser("MANAGER");
    const { location } = await makeWarehouseAndLocation(organization.id);

    const { intake } = await createIntake({
      organizationId: organization.id,
      locationId: location.id,
      boxes: 1,
      unitsPerBox: 1,
      looseUnits: 0,
      createdById: manager.id,
      idempotencyKey: randomUUID(),
      requestHash: computeRequestHash({ salt: randomUUID() }),
    });

    await approveIntake({
      organizationId: organization.id,
      intakeId: intake.id,
      actorUserId: manager.id,
      productDetails: { sku: `SKU-DOUBLE-APPROVE-${randomUUID()}`, name: "Double approve target" },
    });

    await expect(
      approveIntake({
        organizationId: organization.id,
        intakeId: intake.id,
        actorUserId: manager.id,
        productDetails: { sku: `SKU-SHOULD-NOT-CREATE-${randomUUID()}`, name: "Should not be created" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects approving an already-REJECTED intake with a clear error", async () => {
    const { organization, user: manager } = await makeOrgUser("MANAGER");
    const { location } = await makeWarehouseAndLocation(organization.id);

    const { intake } = await createIntake({
      organizationId: organization.id,
      locationId: location.id,
      boxes: 1,
      unitsPerBox: 1,
      looseUnits: 0,
      createdById: manager.id,
      idempotencyKey: randomUUID(),
      requestHash: computeRequestHash({ salt: randomUUID() }),
    });

    await rejectIntake({
      organizationId: organization.id,
      intakeId: intake.id,
      actorUserId: manager.id,
      notes: "No good.",
    });

    await expect(
      approveIntake({
        organizationId: organization.id,
        intakeId: intake.id,
        actorUserId: manager.id,
        productDetails: { sku: `SKU-REJECTED-${randomUUID()}`, name: "Should not be created" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
