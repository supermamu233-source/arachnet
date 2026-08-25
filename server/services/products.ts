import { Prisma } from "@/lib/generated/prisma/client";
import type { BarcodeType } from "@/lib/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/errors";
import { recordAudit } from "@/server/services/audit";
import { isValidEanChecksum } from "@/domain/products/ean";
import {
  findExactMatches,
  findSuggestions,
  type CatalogEntry,
  type ExactMatchCandidate,
} from "@/domain/products/matching";

export interface CreateProductBarcodeInput {
  value: string;
  type?: BarcodeType;
  isPrimary?: boolean;
}

export interface CreateProductParams {
  organizationId: string;
  sku: string;
  name: string;
  category?: string;
  brand?: string;
  variant?: string;
  description?: string;
  defaultUnitsPerBox: number;
  barcodes: CreateProductBarcodeInput[];
  actorUserId: string;
}

/**
 * Creates a product plus its barcodes in a single transaction.
 *
 * Product principle 2.3: automatic matching may only rely on exact
 * identifiers, and checksum validity is a data-quality signal, not a
 * matching gate. A physically-scanned real-world barcode with a bad check
 * digit (mis-print, damaged label, foreign GS1 prefix we don't validate)
 * still needs to be recordable — refusing to save it would make the
 * physical count impossible to reconcile. So an EAN13/EAN8 barcode that
 * fails `isValidEanChecksum` is still persisted, but the per-barcode
 * response is annotated `checksumWarning: true` so the UI can flag it for a
 * human to double-check, without blocking the save.
 */
export async function createProduct(params: CreateProductParams) {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          organizationId: params.organizationId,
          sku: params.sku,
          name: params.name,
          category: params.category,
          brand: params.brand,
          variant: params.variant,
          description: params.description,
          defaultUnitsPerBox: params.defaultUnitsPerBox,
        },
      });

      const barcodes = [];
      for (const barcode of params.barcodes) {
        const type = barcode.type ?? "EAN13";
        const created = await tx.productBarcode.create({
          data: {
            organizationId: params.organizationId,
            productId: product.id,
            value: barcode.value,
            type,
            isPrimary: barcode.isPrimary ?? false,
          },
        });
        const checksumWarning =
          (type === "EAN13" || type === "EAN8") && !isValidEanChecksum(barcode.value);
        barcodes.push({ ...created, checksumWarning });
      }

      return { product, barcodes };
    });

    await recordAudit({
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      action: "product.created",
      entityType: "Product",
      entityId: result.product.id,
      newValue: { sku: result.product.sku, name: result.product.name },
    });

    return result;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const target = Array.isArray(error.meta?.target) ? error.meta.target.join(",") : String(error.meta?.target ?? "");
      if (target.includes("sku")) {
        throw new ApiError("CONFLICT", `A product with SKU "${params.sku}" already exists.`);
      }
      throw new ApiError("CONFLICT", "One of the provided barcodes is already assigned to another product.");
    }
    throw error;
  }
}

export interface UpdateProductParams {
  organizationId: string;
  productId: string;
  actorUserId: string;
  name?: string;
  category?: string;
  brand?: string;
  variant?: string;
  description?: string;
  defaultUnitsPerBox?: number;
}

export async function updateProduct(params: UpdateProductParams) {
  const existing = await prisma.product.findUnique({ where: { id: params.productId } });
  if (!existing || existing.organizationId !== params.organizationId) {
    throw new ApiError("PRODUCT_NOT_FOUND", "Product not found.");
  }

  const updated = await prisma.product.update({
    where: { id: params.productId },
    data: {
      name: params.name,
      category: params.category,
      brand: params.brand,
      variant: params.variant,
      description: params.description,
      defaultUnitsPerBox: params.defaultUnitsPerBox,
    },
  });

  await recordAudit({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    action: "product.updated",
    entityType: "Product",
    entityId: updated.id,
    oldValue: existing,
    newValue: updated,
  });

  return updated;
}

export interface ArchiveProductParams {
  organizationId: string;
  productId: string;
  actorUserId: string;
}

/** Archives a product. Never a hard delete — sets archivedAt + active:false
 * so historical counts/discrepancies referencing it remain intact. */
export async function archiveProduct(params: ArchiveProductParams) {
  const existing = await prisma.product.findUnique({ where: { id: params.productId } });
  if (!existing || existing.organizationId !== params.organizationId) {
    throw new ApiError("PRODUCT_NOT_FOUND", "Product not found.");
  }

  const archived = await prisma.product.update({
    where: { id: params.productId },
    data: { archivedAt: new Date(), active: false },
  });

  await recordAudit({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    action: "product.archived",
    entityType: "Product",
    entityId: archived.id,
    oldValue: { active: existing.active, archivedAt: existing.archivedAt },
    newValue: { active: archived.active, archivedAt: archived.archivedAt },
  });

  return archived;
}

async function loadCatalog(organizationId: string): Promise<CatalogEntry[]> {
  const products = await prisma.product.findMany({
    where: { organizationId },
    select: { id: true, sku: true, barcodes: { select: { value: true } } },
  });
  // No separate alias table exists yet — aliases stay empty until one is added.
  return products.map((product) => ({
    productId: product.id,
    sku: product.sku,
    barcodes: product.barcodes.map((b) => b.value),
    aliases: [],
  }));
}

export type SearchProductsMode = "exact" | "prefix" | "name";

export interface SearchProductsParams {
  organizationId: string;
  query: string;
  mode: SearchProductsMode;
}

type ProductWithBarcodes = Prisma.ProductGetPayload<{ include: { barcodes: true } }>;

/**
 * Search entry point for the products list UI. Exact matches (EAN/SKU/alias)
 * and non-exact suggestions are always returned in separate, clearly labeled
 * buckets — never merged into one list a caller could mistake as authoritative
 * (product principle 2.3).
 *
 * Overloaded per mode so callers (route handlers, tests) get a precisely
 * typed result shape instead of a loosely-typed union of every branch.
 */
export async function searchProducts(
  params: SearchProductsParams & { mode: "exact" },
): Promise<{ exactMatches: Array<ExactMatchCandidate & { product: ProductWithBarcodes | null }> }>;
export async function searchProducts(
  params: SearchProductsParams & { mode: "prefix" },
): Promise<{ exactMatches: []; products: ProductWithBarcodes[] }>;
export async function searchProducts(
  params: SearchProductsParams & { mode: "name" },
): Promise<{ suggestions: ProductWithBarcodes[] }>;
// Fallback overload for callers (e.g. a route handler) holding a plain,
// not-yet-narrowed SearchProductsMode rather than a literal.
export async function searchProducts(
  params: SearchProductsParams,
): Promise<
  | { exactMatches: Array<ExactMatchCandidate & { product: ProductWithBarcodes | null }> }
  | { exactMatches: []; products: ProductWithBarcodes[] }
  | { suggestions: ProductWithBarcodes[] }
>;
export async function searchProducts(params: SearchProductsParams) {
  if (params.mode === "exact") {
    const catalog = await loadCatalog(params.organizationId);
    const candidates = findExactMatches(params.query, catalog);
    const productIds = [...new Set(candidates.map((c) => c.productId))];
    const products = await prisma.product.findMany({
      where: { organizationId: params.organizationId, id: { in: productIds } },
      include: { barcodes: true },
    });
    return {
      exactMatches: candidates.map((candidate) => ({
        ...candidate,
        product: products.find((p) => p.id === candidate.productId) ?? null,
      })),
    };
  }

  if (params.mode === "prefix") {
    const products = await prisma.product.findMany({
      where: { organizationId: params.organizationId, sku: { startsWith: params.query } },
      include: { barcodes: true },
      take: 50,
    });
    return { exactMatches: [], products };
  }

  // mode === "name": non-exact, human-reviewed-only suggestions.
  const catalog = await prisma.product.findMany({
    where: { organizationId: params.organizationId },
    select: { id: true, sku: true, name: true, category: true, brand: true },
  });
  const suggestionIds = findSuggestions(
    params.query,
    catalog.map((c) => ({ productId: c.id, name: c.name, sku: c.sku, category: c.category, brand: c.brand })),
  );
  const products = await prisma.product.findMany({
    where: { organizationId: params.organizationId, id: { in: suggestionIds } },
    include: { barcodes: true },
  });
  return { suggestions: products };
}

export interface GetProductLookupParams {
  organizationId: string;
  code: string;
}

/**
 * The scan-to-product flow used during counting: exact-match only (EAN or
 * SKU). Never returns suggestions — this answers "did we get an exact hit".
 */
export async function getProductLookup(params: GetProductLookupParams) {
  const catalog = await loadCatalog(params.organizationId);
  const candidates = findExactMatches(params.code, catalog);
  if (candidates.length === 0) {
    throw new ApiError("PRODUCT_NOT_FOUND", "No product matches this code.");
  }

  const product = await prisma.product.findUnique({
    where: { id: candidates[0].productId },
    include: { barcodes: true },
  });
  if (!product || product.organizationId !== params.organizationId) {
    throw new ApiError("PRODUCT_NOT_FOUND", "No product matches this code.");
  }

  return product;
}
