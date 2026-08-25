import { z } from "zod";
import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireAuthContext } from "@/server/auth/session";
import { searchProducts } from "@/server/services/products";

const querySchema = z.object({
  q: z.string().min(1),
  mode: z.enum(["exact", "prefix", "name"]),
});

export async function GET(request: Request) {
  const requestId = newRequestId();
  try {
    const context = await requireAuthContext();
    const { searchParams } = new URL(request.url);
    const { q, mode } = querySchema.parse({
      q: searchParams.get("q") ?? undefined,
      mode: searchParams.get("mode") ?? undefined,
    });

    const result = await searchProducts({ organizationId: context.organizationId, query: q, mode });
    return ok(result, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
