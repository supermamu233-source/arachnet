import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { prisma } from "@/lib/prisma";
import { getEnv } from "@/lib/env";
import { ApiError } from "@/lib/errors";
import { sha256Hex } from "@/lib/hashing";
import { recordAudit } from "@/server/services/audit";
import { objectStorage } from "@/storage/s3-storage";
import type { EvidenceAsset } from "@/lib/generated/prisma/client";
import type { EvidencePurpose } from "@/lib/generated/prisma/enums";

/** MIME types we ever accept for evidence uploads. Anything else is rejected
 * both at presign time (client-declared) and at finalize time (actually
 * decoded), per the "never trust a client-declared MIME type alone"
 * principle. */
const ALLOWED_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

const EXTENSION_BY_CONTENT_TYPE: Record<AllowedContentType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** sharp's decoded format names, used to cross-check against the allowed
 * MIME types after actually decoding the bytes — never trust the extension
 * or the client-declared Content-Type alone. */
const ALLOWED_SHARP_FORMATS = new Set(["jpeg", "png", "webp"]);

const DISPLAY_MAX_EDGE_PX = 1400;
const DISPLAY_JPEG_QUALITY = 82;
const THUMB_MAX_EDGE_PX = 220;
const THUMB_JPEG_QUALITY = 80;

const SIGNED_GET_EXPIRES_SECONDS = 5 * 60;

function isAllowedContentType(contentType: string): contentType is AllowedContentType {
  return (ALLOWED_CONTENT_TYPES as readonly string[]).includes(contentType);
}

function displayKeyFor(objectKey: string): string {
  return `${objectKey}.display.jpg`;
}

function thumbKeyFor(objectKey: string): string {
  return `${objectKey}.thumb.jpg`;
}

async function loadEvidenceAsset(assetId: string): Promise<EvidenceAsset> {
  const asset = await prisma.evidenceAsset.findUnique({ where: { id: assetId } });
  if (!asset) {
    throw new ApiError("EVIDENCE_NOT_FOUND", "Evidence asset not found.");
  }
  return asset;
}

/**
 * Same check as `server/auth/session.ts`'s `assertSameOrganization`, but
 * usable here without constructing a full `AuthContext` — every function in
 * this file only ever receives the caller's `organizationId` string, not the
 * whole session context. Throws the identical `ORGANIZATION_MISMATCH` code
 * so callers/tests can't tell the difference.
 */
function assertOwnedByOrganization(callerOrganizationId: string, resourceOrganizationId: string): void {
  if (callerOrganizationId !== resourceOrganizationId) {
    throw new ApiError("ORGANIZATION_MISMATCH", "Resource does not belong to this organization.");
  }
}

interface CreatePresignedUploadParams {
  organizationId: string;
  purpose: EvidencePurpose;
  contentType: string;
  maxBytes: number;
  createdById: string;
}

export async function createPresignedUpload(params: CreatePresignedUploadParams): Promise<{
  uploadUrl: string;
  assetId: string;
  objectKey: string;
}> {
  const env = getEnv();

  if (!isAllowedContentType(params.contentType)) {
    throw new ApiError(
      "EVIDENCE_TYPE_REJECTED",
      `Content type "${params.contentType}" is not an accepted image type.`,
    );
  }

  if (params.maxBytes > env.MAX_UPLOAD_BYTES) {
    throw new ApiError(
      "EVIDENCE_TOO_LARGE",
      `Requested max size ${params.maxBytes} bytes exceeds the ${env.MAX_UPLOAD_BYTES} byte limit.`,
    );
  }

  // The random component is a fresh UUID, never the DB row id — using the
  // row id here would let a caller enumerate/guess object keys before the
  // corresponding asset even exists.
  const extension = EXTENSION_BY_CONTENT_TYPE[params.contentType];
  const objectKey = `org/${params.organizationId}/evidence/${params.purpose}/${randomUUID()}.${extension}`;

  const asset = await prisma.evidenceAsset.create({
    data: {
      organizationId: params.organizationId,
      objectKey,
      purpose: params.purpose,
      contentType: params.contentType,
      expectedBytes: params.maxBytes,
      status: "PENDING",
      createdById: params.createdById,
    },
  });

  const { url } = await objectStorage.presignPut(objectKey, params.contentType, params.maxBytes);

  return { uploadUrl: url, assetId: asset.id, objectKey };
}

interface FinalizeEvidenceParams {
  organizationId: string;
  assetId: string;
  actorUserId: string;
}

export async function finalizeEvidence(params: FinalizeEvidenceParams): Promise<EvidenceAsset> {
  const env = getEnv();
  const asset = await loadEvidenceAsset(params.assetId);
  assertOwnedByOrganization(params.organizationId, asset.organizationId);

  // Finalizing an already-VERIFIED asset is treated as an idempotent replay
  // (e.g. a retried request after a dropped response) rather than an error —
  // the bytes were already verified and the derived variants already exist,
  // so we just hand back the current row unchanged. Anything else that isn't
  // PENDING (REJECTED/DELETED) is a real conflict: the asset can never become
  // usable again through this path.
  if (asset.status === "VERIFIED") {
    return asset;
  }
  if (asset.status !== "PENDING") {
    throw new ApiError("EVIDENCE_NOT_READY", `Evidence asset is ${asset.status} and cannot be finalized.`);
  }

  const head = await objectStorage.headObject(asset.objectKey);
  if (!head) {
    throw new ApiError("EVIDENCE_NOT_FOUND", "No object was uploaded for this evidence asset.");
  }

  const maxBytes = asset.expectedBytes ?? env.MAX_UPLOAD_BYTES;
  if (head.contentLength > maxBytes || head.contentLength > env.MAX_UPLOAD_BYTES) {
    throw new ApiError(
      "EVIDENCE_TOO_LARGE",
      `Uploaded object is ${head.contentLength} bytes, exceeding the ${maxBytes} byte limit.`,
    );
  }

  const buffer = await objectStorage.getObjectBuffer(asset.objectKey);

  if (buffer.byteLength > maxBytes || buffer.byteLength > env.MAX_UPLOAD_BYTES) {
    throw new ApiError(
      "EVIDENCE_TOO_LARGE",
      `Uploaded object is ${buffer.byteLength} bytes, exceeding the ${maxBytes} byte limit.`,
    );
  }

  const sha256 = sha256Hex(buffer);

  // Actually decode the image server-side — never trust the client-declared
  // Content-Type or the file extension alone.
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    metadata = await sharp(buffer).metadata();
  } catch {
    throw new ApiError("EVIDENCE_TYPE_REJECTED", "Uploaded object could not be decoded as an image.");
  }

  if (!metadata.format || !ALLOWED_SHARP_FORMATS.has(metadata.format) || !metadata.width || !metadata.height) {
    throw new ApiError(
      "EVIDENCE_TYPE_REJECTED",
      `Uploaded object is not one of the accepted image formats (detected: ${metadata.format ?? "unknown"}).`,
    );
  }

  const displayBuffer = await sharp(buffer)
    .rotate() // apply EXIF orientation before resizing
    .resize({ width: DISPLAY_MAX_EDGE_PX, height: DISPLAY_MAX_EDGE_PX, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: DISPLAY_JPEG_QUALITY })
    .toBuffer();

  const thumbBuffer = await sharp(buffer)
    .rotate()
    .resize({ width: THUMB_MAX_EDGE_PX, height: THUMB_MAX_EDGE_PX, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: THUMB_JPEG_QUALITY })
    .toBuffer();

  await objectStorage.putObjectBuffer(displayKeyFor(asset.objectKey), displayBuffer, "image/jpeg");
  await objectStorage.putObjectBuffer(thumbKeyFor(asset.objectKey), thumbBuffer, "image/jpeg");

  const updated = await prisma.evidenceAsset.update({
    where: { id: asset.id },
    data: {
      actualBytes: buffer.byteLength,
      sha256,
      width: metadata.width,
      height: metadata.height,
      status: "VERIFIED",
      verifiedAt: new Date(),
    },
  });

  await recordAudit({
    organizationId: asset.organizationId,
    actorUserId: params.actorUserId,
    action: "evidence.finalized",
    entityType: "EvidenceAsset",
    entityId: asset.id,
    oldValue: { status: asset.status },
    newValue: { status: updated.status, sha256: updated.sha256, width: updated.width, height: updated.height },
  });

  return updated;
}

interface GetSignedDownloadUrlParams {
  organizationId: string;
  assetId: string;
}

export async function getSignedDownloadUrl(
  params: GetSignedDownloadUrlParams,
): Promise<{ url: string; expiresAt: Date }> {
  const asset = await loadEvidenceAsset(params.assetId);
  assertOwnedByOrganization(params.organizationId, asset.organizationId);

  if (asset.status !== "VERIFIED") {
    throw new ApiError("EVIDENCE_NOT_READY", `Evidence asset is ${asset.status}, not yet verified.`);
  }

  const url = await objectStorage.presignGet(displayKeyFor(asset.objectKey), SIGNED_GET_EXPIRES_SECONDS);
  const expiresAt = new Date(Date.now() + SIGNED_GET_EXPIRES_SECONDS * 1000);
  return { url, expiresAt };
}

interface DeleteEvidenceParams {
  organizationId: string;
  assetId: string;
  actorUserId: string;
}

export async function deleteEvidence(params: DeleteEvidenceParams): Promise<EvidenceAsset> {
  const asset = await loadEvidenceAsset(params.assetId);
  assertOwnedByOrganization(params.organizationId, asset.organizationId);

  await Promise.all([
    objectStorage.deleteObject(asset.objectKey),
    objectStorage.deleteObject(displayKeyFor(asset.objectKey)),
    objectStorage.deleteObject(thumbKeyFor(asset.objectKey)),
  ]);

  const updated = await prisma.evidenceAsset.update({
    where: { id: asset.id },
    data: { status: "DELETED", deletedAt: new Date() },
  });

  await recordAudit({
    organizationId: asset.organizationId,
    actorUserId: params.actorUserId,
    action: "evidence.deleted",
    entityType: "EvidenceAsset",
    entityId: asset.id,
    oldValue: { status: asset.status },
    newValue: { status: updated.status },
  });

  return updated;
}
