import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireRole } from "@/server/auth/session";
import { deleteEvidence, getSignedDownloadUrl } from "@/server/services/evidence";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    // Any authenticated org member may view evidence (COUNTER is the lowest
    // active role; VIEWER is read-only elsewhere but evidence viewing is
    // still gated behind organization membership via requireRole/asserted
    // ownership below).
    const context = await requireRole("VIEWER");
    const { id } = await params;

    const { url, expiresAt } = await getSignedDownloadUrl({
      organizationId: context.organizationId,
      assetId: id,
    });

    return ok({ url, expiresAt }, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("MANAGER");
    const { id } = await params;

    const asset = await deleteEvidence({
      organizationId: context.organizationId,
      assetId: id,
      actorUserId: context.userId,
    });

    return ok(asset, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
