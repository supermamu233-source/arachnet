import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireAuthContext, requireRole } from "@/server/auth/session";
import { createProduct } from "@/server/services/products";

const barcodeTypeSchema = z.enum(["EAN13", "EAN8", "UPC_A", "CODE128", "OTHER"]);

const createSchema = z.object({
  sku: z.string().min(1).max(100),
  name: z.string().min(1).max(300),
  category: z.string().max(150).optional(),
  brand: z.string().max(150).optional(),
  variant: z.string().max(150).optional(),
  description: z.string().max(2000).optional(),
  defaultUnitsPerBox: z.number().int().min(1),
  barcodes: z
    .array(
      z.object({
        value: z.string().min(1).max(64),
        type: barcodeTypeSchema.optional(),
        isPrimary: z.boolean().optional(),
      }),
    )
    .default([]),
});

// MVP list, capped rather than paginated — see brief section 4.
const PRODUCT_LIST_CAP = 200;

export async function GET() {
  const requestId = newRequestId();
  try {
    const context = await requireAuthContext();
    const products = await prisma.product.findMany({
      where: { organizationId: context.organizationId },
      orderBy: { createdAt: "desc" },
      take: PRODUCT_LIST_CAP,
      include: { barcodes: true },
    });
    return ok(products, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}

export async function POST(request: Request) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("MANAGER");
    const body = createSchema.parse(await request.json());

    const result = await createProduct({
      organizationId: context.organizationId,
      sku: body.sku,
      name: body.name,
      category: body.category,
      brand: body.brand,
      variant: body.variant,
      description: body.description,
      defaultUnitsPerBox: body.defaultUnitsPerBox,
      barcodes: body.barcodes,
      actorUserId: context.userId,
    });

    return ok(result, requestId, { status: 201 });
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
