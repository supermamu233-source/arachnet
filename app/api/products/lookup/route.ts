import { z } from "zod";
import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireAuthContext } from "@/server/auth/session";
import { getProductLookup } from "@/server/services/products";

const querySchema = z.object({ code: z.string().min(1) });

export async function GET(request: Request) {
  const requestId = newRequestId();
  try {
    const context = await requireAuthContext();
    const { searchParams } = new URL(request.url);
    const { code } = querySchema.parse({ code: searchParams.get("code") ?? undefined });

    const product = await getProductLookup({ organizationId: context.organizationId, code });
    return ok(product, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
