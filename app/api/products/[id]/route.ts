import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError, ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireAuthContext, requireRole } from "@/server/auth/session";
import { archiveProduct, updateProduct } from "@/server/services/products";

const updateSchema = z.object({
  name: z.string().min(1).max(300).optional(),
  category: z.string().max(150).optional(),
  brand: z.string().max(150).optional(),
  variant: z.string().max(150).optional(),
  description: z.string().max(2000).optional(),
  defaultUnitsPerBox: z.number().int().min(1).optional(),
});

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const context = await requireAuthContext();
    const { id } = await params;

    const product = await prisma.product.findUnique({
      where: { id },
      include: {
        barcodes: true,
        packagingRules: true,
        productLocations: { include: { location: true } },
      },
    });
    if (!product || product.organizationId !== context.organizationId) {
      throw new ApiError("PRODUCT_NOT_FOUND", "Product not found.");
    }

    return ok(product, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("MANAGER");
    const { id } = await params;
    const body = updateSchema.parse(await request.json());

    const product = await updateProduct({
      organizationId: context.organizationId,
      productId: id,
      actorUserId: context.userId,
      ...body,
    });

    return ok(product, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("MANAGER");
    const { id } = await params;

    // Never a hard delete — archiveProduct sets archivedAt + active:false.
    const product = await archiveProduct({
      organizationId: context.organizationId,
      productId: id,
      actorUserId: context.userId,
    });

    return ok(product, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
