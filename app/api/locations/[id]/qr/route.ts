import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireAuthContext } from "@/server/auth/session";
import { generateLocationQrPngDataUrl, getLocationWithAncestors } from "@/server/services/locations";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const context = await requireAuthContext();
    const { id } = await params;

    const chain = await getLocationWithAncestors(context.organizationId, id);
    const location = chain[chain.length - 1];
    const dataUrl = await generateLocationQrPngDataUrl(location.code);

    return ok({ code: location.code, dataUrl }, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
