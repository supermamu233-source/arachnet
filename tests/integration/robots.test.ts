import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { authenticateRobot } from "@/server/auth/robot-auth";
import { createRobot, disableRobot } from "@/server/services/robots";
import { ingestObservation } from "@/server/services/robot-observations";
import { createTestOrgAndUser } from "@/tests/integration/helpers";

/**
 * Genuine integration test against the real local Postgres (arachnet_test,
 * via `dotenv -e .env.test -- vitest run tests/integration/robots.test.ts`).
 * Evidence assets are created directly as already-VERIFIED rows (the real
 * presign -> upload -> finalize pipeline against MinIO is already covered by
 * tests/integration/evidence.test.ts) so this file can focus on the robot
 * ingestion logic itself: idempotency, EAN/location resolution, evidence
 * validation, server-side quantity calculation, confidence classification,
 * and reconciliation.
 */
describe("robot ingestion", () => {
  const createdOrganizationIds: string[] = [];

  afterAll(async () => {
    if (createdOrganizationIds.length > 0) {
      await prisma.organization.deleteMany({ where: { id: { in: createdOrganizationIds } } });
    }
    await prisma.$disconnect();
  });

  const EAN = "8431234567890";
  const UNITS_PER_BOX = 6;
  const LOCATION_CODE = "WH1-A03-RB-L04";
  const EXPECTED_QTY = 82;

  async function makeFixture() {
    const { organization, user } = await createTestOrgAndUser("ADMIN");
    createdOrganizationIds.push(organization.id);

    const warehouse = await prisma.warehouse.create({
      data: {
        organizationId: organization.id,
        name: "Test warehouse",
        code: `WH-${randomUUID().slice(0, 8)}`,
      },
    });

    const location = await prisma.location.create({
      data: {
        organizationId: organization.id,
        warehouseId: warehouse.id,
        code: LOCATION_CODE,
        name: "Test location",
        type: "BIN",
      },
    });

    const product = await prisma.product.create({
      data: {
        organizationId: organization.id,
        sku: `SKU-${randomUUID().slice(0, 8)}`,
        name: "Test product",
        defaultUnitsPerBox: UNITS_PER_BOX,
      },
    });

    await prisma.productBarcode.create({
      data: { organizationId: organization.id, productId: product.id, value: EAN, type: "EAN13" },
    });

    const source = await prisma.inventorySource.create({
      data: { organizationId: organization.id, type: "MANUAL", name: `Source-${randomUUID().slice(0, 8)}` },
    });

    await prisma.expectedStockBalance.create({
      data: {
        organizationId: organization.id,
        warehouseId: warehouse.id,
        productId: product.id,
        locationId: location.id,
        sourceId: source.id,
        quantity: EXPECTED_QTY,
        sourceUpdatedAt: new Date(),
      },
    });

    const { robot, secret } = await createRobot({
      organizationId: organization.id,
      warehouseId: warehouse.id,
      code: `scout-${randomUUID().slice(0, 8)}`,
      name: "Test robot",
      actorUserId: user.id,
    });

    return { organization, user, warehouse, location, product, robot, secret };
  }

  async function makeVerifiedEvidence(organizationId: string) {
    return prisma.evidenceAsset.create({
      data: {
        organizationId,
        objectKey: `org/${organizationId}/evidence/ROBOT_IMAGE/${randomUUID()}.jpg`,
        purpose: "ROBOT_IMAGE",
        contentType: "image/jpeg",
        status: "VERIFIED",
        verifiedAt: new Date(),
      },
    });
  }

  it("computes observed/expected/difference, creates a discrepancy, links evidence, and records an audit entry", async () => {
    const fx = await makeFixture();
    const evidence = await makeVerifiedEvidence(fx.organization.id);
    const eventId = randomUUID();

    const result = await ingestObservation({
      robotId: fx.robot.id,
      organizationId: fx.organization.id,
      warehouseId: fx.warehouse.id,
      eventId,
      capturedAt: new Date().toISOString(),
      locationCode: LOCATION_CODE,
      ean: EAN,
      boxes: 12,
      looseUnits: 2,
      confidence: 0.97,
      evidenceIds: [evidence.id],
      rawPayload: { scanner: "simulator", camera: "sample-image" },
    });

    expect(result.replay).toBe(false);
    expect(result.observation.observedQuantity).toBe(74);
    expect(result.observation.expectedQuantity).toBe(82);
    expect(result.observation.difference).toBe(-8);
    expect(result.observation.confidenceLevel).toBe("HIGH");
    expect(result.observation.status).toBe("ACCEPTED");

    const discrepancy = await prisma.inventoryDiscrepancy.findUnique({
      where: {
        organizationId_productId_locationId: {
          organizationId: fx.organization.id,
          productId: fx.product.id,
          locationId: fx.location.id,
        },
      },
    });
    expect(discrepancy).not.toBeNull();
    expect(discrepancy?.expectedQuantity).toBe(82);
    expect(discrepancy?.observedQuantity).toBe(74);
    expect(discrepancy?.difference).toBe(-8);
    expect(discrepancy?.status).toBe("SHORTAGE");

    const audit = await prisma.auditLog.findFirst({
      where: { organizationId: fx.organization.id, entityType: "RobotObservation", entityId: result.observation.id },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorType).toBe("ROBOT");
    expect(audit?.actorRobotId).toBe(fx.robot.id);
    expect(audit?.action).toBe("robot_observation.ingested");

    const linked = await prisma.robotObservation.findUnique({
      where: { id: result.observation.id },
      include: { evidence: true },
    });
    expect(linked?.evidence.map((e) => e.id)).toContain(evidence.id);

    // --- replaying the exact same event is a no-op: no second row created ---
    const replayResult = await ingestObservation({
      robotId: fx.robot.id,
      organizationId: fx.organization.id,
      warehouseId: fx.warehouse.id,
      eventId,
      capturedAt: result.observation.capturedAt.toISOString(),
      locationCode: LOCATION_CODE,
      ean: EAN,
      boxes: 12,
      looseUnits: 2,
      confidence: 0.97,
      evidenceIds: [evidence.id],
      rawPayload: { scanner: "simulator", camera: "sample-image" },
    });
    expect(replayResult.replay).toBe(true);
    expect(replayResult.observation.id).toBe(result.observation.id);

    const countAfterReplay = await prisma.robotObservation.count({ where: { robotId: fx.robot.id, eventId } });
    expect(countAfterReplay).toBe(1);

    // --- same event id, different payload -> 409 IDEMPOTENCY_CONFLICT ---
    await expect(
      ingestObservation({
        robotId: fx.robot.id,
        organizationId: fx.organization.id,
        warehouseId: fx.warehouse.id,
        eventId,
        capturedAt: result.observation.capturedAt.toISOString(),
        locationCode: LOCATION_CODE,
        ean: EAN,
        boxes: 99, // different from the original 12
        looseUnits: 2,
        confidence: 0.97,
        evidenceIds: [evidence.id],
        rawPayload: { scanner: "simulator", camera: "sample-image" },
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });

    // --- a later observation matching the expected quantity resolves the discrepancy ---
    const resolvingEvidence = await makeVerifiedEvidence(fx.organization.id);
    const laterCapturedAt = new Date(result.observation.capturedAt.getTime() + 60_000).toISOString();
    const resolvingResult = await ingestObservation({
      robotId: fx.robot.id,
      organizationId: fx.organization.id,
      warehouseId: fx.warehouse.id,
      eventId: randomUUID(),
      capturedAt: laterCapturedAt,
      locationCode: LOCATION_CODE,
      ean: EAN,
      boxes: 13,
      looseUnits: 4, // 13 * 6 + 4 = 82, matches the expected balance exactly
      confidence: 0.99,
      evidenceIds: [resolvingEvidence.id],
      rawPayload: { scanner: "simulator" },
    });
    expect(resolvingResult.observation.observedQuantity).toBe(82);
    expect(resolvingResult.observation.status).toBe("ACCEPTED");

    const resolvedDiscrepancy = await prisma.inventoryDiscrepancy.findUnique({
      where: {
        organizationId_productId_locationId: {
          organizationId: fx.organization.id,
          productId: fx.product.id,
          locationId: fx.location.id,
        },
      },
    });
    expect(resolvedDiscrepancy?.status).toBe("RESOLVED");
    expect(resolvedDiscrepancy?.observedQuantity).toBe(82);

    // --- the official expected balance itself is never mutated by any of this ---
    const balance = await prisma.expectedStockBalance.findFirst({
      where: { organizationId: fx.organization.id, productId: fx.product.id, locationId: fx.location.id },
    });
    expect(balance?.quantity).toBe(82);
  });

  it("rejects an unknown robot code with 401 ROBOT_UNAUTHENTICATED", async () => {
    const request = new Request("http://localhost/api/robot/observations", {
      method: "POST",
      headers: { "x-robot-id": "does-not-exist", authorization: "Bearer whatever-secret" },
    });
    await expect(authenticateRobot(request)).rejects.toMatchObject({
      code: "ROBOT_UNAUTHENTICATED",
      status: 401,
    });
  });

  it("rejects a known robot code with the wrong secret with 401 ROBOT_UNAUTHENTICATED", async () => {
    const fx = await makeFixture();
    const request = new Request("http://localhost/api/robot/observations", {
      method: "POST",
      headers: { "x-robot-id": fx.robot.code, authorization: "Bearer not-the-real-secret" },
    });
    await expect(authenticateRobot(request)).rejects.toMatchObject({
      code: "ROBOT_UNAUTHENTICATED",
      status: 401,
    });
  });

  it("rejects a disabled robot with 403 ROBOT_DISABLED", async () => {
    const fx = await makeFixture();
    await disableRobot({ organizationId: fx.organization.id, robotId: fx.robot.id, actorUserId: fx.user.id });

    const request = new Request("http://localhost/api/robot/observations", {
      method: "POST",
      headers: { "x-robot-id": fx.robot.code, authorization: `Bearer ${fx.secret}` },
    });
    await expect(authenticateRobot(request)).rejects.toMatchObject({
      code: "ROBOT_DISABLED",
      status: 403,
    });
  });

  it("rejects an observation with no evidence with 422 VALIDATION_ERROR", async () => {
    const fx = await makeFixture();

    await expect(
      ingestObservation({
        robotId: fx.robot.id,
        organizationId: fx.organization.id,
        warehouseId: fx.warehouse.id,
        eventId: randomUUID(),
        capturedAt: new Date().toISOString(),
        locationCode: LOCATION_CODE,
        ean: EAN,
        boxes: 12,
        looseUnits: 2,
        confidence: 0.97,
        evidenceIds: [],
        rawPayload: {},
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 422 });
  });

  it("rejects an observation referencing an evidence asset that was never finalized with 422 VALIDATION_ERROR", async () => {
    const fx = await makeFixture();
    const pendingEvidence = await prisma.evidenceAsset.create({
      data: {
        organizationId: fx.organization.id,
        objectKey: `org/${fx.organization.id}/evidence/ROBOT_IMAGE/${randomUUID()}.jpg`,
        purpose: "ROBOT_IMAGE",
        contentType: "image/jpeg",
        status: "PENDING",
      },
    });

    await expect(
      ingestObservation({
        robotId: fx.robot.id,
        organizationId: fx.organization.id,
        warehouseId: fx.warehouse.id,
        eventId: randomUUID(),
        capturedAt: new Date().toISOString(),
        locationCode: LOCATION_CODE,
        ean: EAN,
        boxes: 12,
        looseUnits: 2,
        confidence: 0.97,
        evidenceIds: [pendingEvidence.id],
        rawPayload: {},
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 422 });
  });

  it("rejects an unknown location code with LOCATION_NOT_FOUND", async () => {
    const fx = await makeFixture();
    const evidence = await makeVerifiedEvidence(fx.organization.id);

    await expect(
      ingestObservation({
        robotId: fx.robot.id,
        organizationId: fx.organization.id,
        warehouseId: fx.warehouse.id,
        eventId: randomUUID(),
        capturedAt: new Date().toISOString(),
        locationCode: "DOES-NOT-EXIST",
        ean: EAN,
        boxes: 12,
        looseUnits: 2,
        confidence: 0.97,
        evidenceIds: [evidence.id],
        rawPayload: {},
      }),
    ).rejects.toMatchObject({ code: "LOCATION_NOT_FOUND" });
  });

  it("records an observation for an unmatched EAN without crashing, and never triggers reconciliation for it", async () => {
    const fx = await makeFixture();
    const evidence = await makeVerifiedEvidence(fx.organization.id);

    const result = await ingestObservation({
      robotId: fx.robot.id,
      organizationId: fx.organization.id,
      warehouseId: fx.warehouse.id,
      eventId: randomUUID(),
      capturedAt: new Date().toISOString(),
      locationCode: LOCATION_CODE,
      ean: "0000000000000",
      boxes: 3,
      looseUnits: 1,
      confidence: 0.99,
      evidenceIds: [evidence.id],
      rawPayload: {},
    });

    expect(result.observation.productId).toBeNull();
    expect(result.observation.status).toBe("REVIEW_REQUIRED");
    expect(result.observation.expectedQuantity).toBeNull();

    // No discrepancy should exist for this product/location pair since there
    // is no product to key one on.
    const discrepancies = await prisma.inventoryDiscrepancy.findMany({
      where: { organizationId: fx.organization.id, locationId: fx.location.id },
    });
    expect(discrepancies).toHaveLength(0);
  });
});
