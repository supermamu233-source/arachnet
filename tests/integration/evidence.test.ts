import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { prisma } from "@/lib/prisma";
import { getEnv } from "@/lib/env";
import { objectStorage } from "@/storage/s3-storage";
import {
  createPresignedUpload,
  deleteEvidence,
  finalizeEvidence,
  getSignedDownloadUrl,
} from "@/server/services/evidence";
import { createTestOrgAndUser } from "@/tests/integration/helpers";

/**
 * Genuine integration test: runs against the real local Postgres
 * (arachnet_test db, via `dotenv -e .env.test -- vitest run ...`) and the
 * real local MinIO instance (arachnet-evidence-test bucket). Nothing here
 * mocks Prisma or the S3 client — every asset really gets uploaded,
 * downloaded, hashed, and decoded.
 */
describe("evidence pipeline", () => {
  const createdOrganizationIds: string[] = [];

  afterAll(async () => {
    // Best-effort cleanup so repeated local test runs don't accumulate rows
    // forever. Cascading deletes on Organization take EvidenceAsset,
    // Membership, etc. with it (see schema onDelete: Cascade).
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

  async function makeTestJpeg(width = 800, height = 600): Promise<Buffer> {
    return sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 120, g: 160, b: 200 },
      },
    })
      .jpeg({ quality: 90 })
      .toBuffer();
  }

  it("happy path: presign, real PUT to MinIO, finalize, and derived variants exist", async () => {
    const { organization, user } = await makeOrgUser();
    const imageBuffer = await makeTestJpeg();

    const presigned = await createPresignedUpload({
      organizationId: organization.id,
      purpose: "COUNT_IMAGE",
      contentType: "image/jpeg",
      maxBytes: getEnv().MAX_UPLOAD_BYTES,
      createdById: user.id,
    });

    expect(presigned.uploadUrl).toContain("http");
    expect(presigned.objectKey).toContain(`org/${organization.id}/evidence/COUNT_IMAGE/`);

    const putResponse = await fetch(presigned.uploadUrl, {
      method: "PUT",
      body: new Uint8Array(imageBuffer),
      headers: { "Content-Type": "image/jpeg" },
    });
    expect(putResponse.ok).toBe(true);

    const finalized = await finalizeEvidence({
      organizationId: organization.id,
      assetId: presigned.assetId,
      actorUserId: user.id,
    });

    expect(finalized.status).toBe("VERIFIED");
    expect(finalized.sha256).toBeTruthy();
    expect(finalized.width).toBe(800);
    expect(finalized.height).toBe(600);
    expect(finalized.verifiedAt).not.toBeNull();

    const displayHead = await objectStorage.headObject(`${presigned.objectKey}.display.jpg`);
    const thumbHead = await objectStorage.headObject(`${presigned.objectKey}.thumb.jpg`);
    expect(displayHead).not.toBeNull();
    expect(thumbHead).not.toBeNull();

    // Re-finalizing (e.g. a retried request) is treated as an idempotent
    // replay, not an error.
    const replay = await finalizeEvidence({
      organizationId: organization.id,
      assetId: presigned.assetId,
      actorUserId: user.id,
    });
    expect(replay.status).toBe("VERIFIED");
    expect(replay.sha256).toBe(finalized.sha256);

    const signed = await getSignedDownloadUrl({ organizationId: organization.id, assetId: presigned.assetId });
    expect(signed.url).toContain("http");
    expect(signed.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const deleted = await deleteEvidence({
      organizationId: organization.id,
      assetId: presigned.assetId,
      actorUserId: user.id,
    });
    expect(deleted.status).toBe("DELETED");
    expect(deleted.deletedAt).not.toBeNull();

    const displayHeadAfterDelete = await objectStorage.headObject(`${presigned.objectKey}.display.jpg`);
    expect(displayHeadAfterDelete).toBeNull();
  });

  it("rejects a non-image (undecodable) upload at finalize", async () => {
    const { organization, user } = await makeOrgUser();

    const presigned = await createPresignedUpload({
      organizationId: organization.id,
      purpose: "PRODUCT_IMAGE",
      contentType: "image/jpeg",
      maxBytes: getEnv().MAX_UPLOAD_BYTES,
      createdById: user.id,
    });

    // Client declares image/jpeg but the actual bytes are plain text — this
    // must be caught by the real sharp() decode step, not just trusted.
    const notAnImage = Buffer.from("this is definitely not a jpeg file".repeat(50));

    const putResponse = await fetch(presigned.uploadUrl, {
      method: "PUT",
      body: new Uint8Array(notAnImage),
      headers: { "Content-Type": "image/jpeg" },
    });
    expect(putResponse.ok).toBe(true);

    await expect(
      finalizeEvidence({
        organizationId: organization.id,
        assetId: presigned.assetId,
        actorUserId: user.id,
      }),
    ).rejects.toMatchObject({ code: "EVIDENCE_TYPE_REJECTED" });
  });

  it("rejects an oversized upload at finalize", async () => {
    const { organization, user } = await makeOrgUser();
    const maxBytes = getEnv().MAX_UPLOAD_BYTES;

    const presigned = await createPresignedUpload({
      organizationId: organization.id,
      purpose: "SHELF_IMAGE",
      contentType: "image/jpeg",
      maxBytes,
      createdById: user.id,
    });

    const oversized = randomBytes(maxBytes + 1024);

    const putResponse = await fetch(presigned.uploadUrl, {
      method: "PUT",
      body: new Uint8Array(oversized),
      headers: { "Content-Type": "image/jpeg" },
    });
    expect(putResponse.ok).toBe(true);

    await expect(
      finalizeEvidence({
        organizationId: organization.id,
        assetId: presigned.assetId,
        actorUserId: user.id,
      }),
    ).rejects.toMatchObject({ code: "EVIDENCE_TOO_LARGE" });
  });

  it("rejects finalizing an asset from a different organization", async () => {
    const { organization: orgA, user: userA } = await makeOrgUser();
    const { organization: orgB } = await makeOrgUser();
    const imageBuffer = await makeTestJpeg();

    const presigned = await createPresignedUpload({
      organizationId: orgA.id,
      purpose: "COUNT_IMAGE",
      contentType: "image/jpeg",
      maxBytes: getEnv().MAX_UPLOAD_BYTES,
      createdById: userA.id,
    });

    await fetch(presigned.uploadUrl, {
      method: "PUT",
      body: new Uint8Array(imageBuffer),
      headers: { "Content-Type": "image/jpeg" },
    });

    await expect(
      finalizeEvidence({
        organizationId: orgB.id,
        assetId: presigned.assetId,
        actorUserId: userA.id,
      }),
    ).rejects.toMatchObject({ code: "ORGANIZATION_MISMATCH" });
  });

  it("rejects finalizing before anything was uploaded", async () => {
    const { organization, user } = await makeOrgUser();

    const presigned = await createPresignedUpload({
      organizationId: organization.id,
      purpose: "BARCODE_CROP",
      contentType: "image/png",
      maxBytes: getEnv().MAX_UPLOAD_BYTES,
      createdById: user.id,
    });

    // Deliberately never PUT anything to presigned.uploadUrl.
    await expect(
      finalizeEvidence({
        organizationId: organization.id,
        assetId: presigned.assetId,
        actorUserId: user.id,
      }),
    ).rejects.toMatchObject({ code: "EVIDENCE_NOT_FOUND" });
  });
});
