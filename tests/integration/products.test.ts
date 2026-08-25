import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  archiveProduct,
  createProduct,
  getProductLookup,
  searchProducts,
  updateProduct,
} from "@/server/services/products";
import { createTestOrgAndUser } from "@/tests/integration/helpers";

// A real, checksum-valid EAN-13 (see tests/unit/ean.test.ts for provenance).
const VALID_EAN13 = "4006381333931";
// Same digits, wrong check digit.
const INVALID_EAN13 = "4006381333930";

describe("products service", () => {
  const createdOrganizationIds: string[] = [];

  afterAll(async () => {
    if (createdOrganizationIds.length > 0) {
      await prisma.organization.deleteMany({ where: { id: { in: createdOrganizationIds } } });
    }
    await prisma.$disconnect();
  });

  async function makeOrgUser(role: "OWNER" | "ADMIN" | "MANAGER" | "COUNTER" | "VIEWER" = "MANAGER") {
    const { organization, user } = await createTestOrgAndUser(role);
    createdOrganizationIds.push(organization.id);
    return { organization, user };
  }

  it("creates a product with a checksum-valid barcode and no warning", async () => {
    const { organization, user } = await makeOrgUser();

    const result = await createProduct({
      organizationId: organization.id,
      sku: "SKU-VALID-1",
      name: "Widget",
      defaultUnitsPerBox: 12,
      barcodes: [{ value: VALID_EAN13, type: "EAN13", isPrimary: true }],
      actorUserId: user.id,
    });

    expect(result.product.sku).toBe("SKU-VALID-1");
    expect(result.barcodes).toHaveLength(1);
    expect(result.barcodes[0].checksumWarning).toBe(false);

    const audit = await prisma.auditLog.findFirst({
      where: { organizationId: organization.id, entityType: "Product", entityId: result.product.id },
    });
    expect(audit?.action).toBe("product.created");
  });

  it("still saves a barcode with an invalid EAN checksum, but flags checksumWarning (principle 2.3)", async () => {
    const { organization, user } = await makeOrgUser();

    const result = await createProduct({
      organizationId: organization.id,
      sku: "SKU-INVALID-EAN-1",
      name: "Damaged label widget",
      defaultUnitsPerBox: 1,
      barcodes: [{ value: INVALID_EAN13, type: "EAN13" }],
      actorUserId: user.id,
    });

    expect(result.barcodes[0].checksumWarning).toBe(true);

    const stored = await prisma.productBarcode.findFirst({ where: { productId: result.product.id } });
    expect(stored?.value).toBe(INVALID_EAN13);
  });

  it("does not flag a checksumWarning for non-EAN barcode types regardless of digits", async () => {
    const { organization, user } = await makeOrgUser();

    const result = await createProduct({
      organizationId: organization.id,
      sku: "SKU-CODE128-1",
      name: "Custom code product",
      defaultUnitsPerBox: 1,
      barcodes: [{ value: "NOT-A-VALID-EAN", type: "CODE128" }],
      actorUserId: user.id,
    });

    expect(result.barcodes[0].checksumWarning).toBe(false);
  });

  it("rejects a duplicate SKU within the same organization with CONFLICT", async () => {
    const { organization, user } = await makeOrgUser();

    await createProduct({
      organizationId: organization.id,
      sku: "SKU-DUP",
      name: "First",
      defaultUnitsPerBox: 1,
      barcodes: [],
      actorUserId: user.id,
    });

    await expect(
      createProduct({
        organizationId: organization.id,
        sku: "SKU-DUP",
        name: "Second",
        defaultUnitsPerBox: 1,
        barcodes: [],
        actorUserId: user.id,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects a duplicate barcode value within the same organization with CONFLICT", async () => {
    const { organization, user } = await makeOrgUser();

    await createProduct({
      organizationId: organization.id,
      sku: "SKU-BC-A",
      name: "First",
      defaultUnitsPerBox: 1,
      barcodes: [{ value: "SHARED-CODE-1", type: "OTHER" }],
      actorUserId: user.id,
    });

    await expect(
      createProduct({
        organizationId: organization.id,
        sku: "SKU-BC-B",
        name: "Second",
        defaultUnitsPerBox: 1,
        barcodes: [{ value: "SHARED-CODE-1", type: "OTHER" }],
        actorUserId: user.id,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("does not partially create a product when a barcode insert fails (transactional)", async () => {
    const { organization, user } = await makeOrgUser();

    await createProduct({
      organizationId: organization.id,
      sku: "SKU-TX-EXISTING",
      name: "Existing",
      defaultUnitsPerBox: 1,
      barcodes: [{ value: "SHARED-CODE-TX", type: "OTHER" }],
      actorUserId: user.id,
    });

    await expect(
      createProduct({
        organizationId: organization.id,
        sku: "SKU-TX-NEW",
        name: "New, should be rolled back",
        defaultUnitsPerBox: 1,
        barcodes: [{ value: "SHARED-CODE-TX", type: "OTHER" }],
        actorUserId: user.id,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const orphan = await prisma.product.findFirst({ where: { organizationId: organization.id, sku: "SKU-TX-NEW" } });
    expect(orphan).toBeNull();
  });

  it("updates a product's mutable fields and records an audit entry", async () => {
    const { organization, user } = await makeOrgUser();
    const { product } = await createProduct({
      organizationId: organization.id,
      sku: "SKU-UPDATE",
      name: "Before",
      defaultUnitsPerBox: 1,
      barcodes: [],
      actorUserId: user.id,
    });

    const updated = await updateProduct({
      organizationId: organization.id,
      productId: product.id,
      actorUserId: user.id,
      name: "After",
      category: "Snacks",
    });

    expect(updated.name).toBe("After");
    expect(updated.category).toBe("Snacks");

    const audit = await prisma.auditLog.findFirst({
      where: { organizationId: organization.id, entityType: "Product", entityId: product.id, action: "product.updated" },
    });
    expect(audit).not.toBeNull();
  });

  it("rejects updating a product belonging to a different organization", async () => {
    const { organization, user } = await makeOrgUser();
    const otherOrg = await makeOrgUser();
    const { product } = await createProduct({
      organizationId: organization.id,
      sku: "SKU-CROSS-ORG",
      name: "Mine",
      defaultUnitsPerBox: 1,
      barcodes: [],
      actorUserId: user.id,
    });

    await expect(
      updateProduct({
        organizationId: otherOrg.organization.id,
        productId: product.id,
        actorUserId: otherOrg.user.id,
        name: "Hijacked",
      }),
    ).rejects.toMatchObject({ code: "PRODUCT_NOT_FOUND" });
  });

  it("archives a product (archivedAt + active:false) rather than deleting it", async () => {
    const { organization, user } = await makeOrgUser();
    const { product } = await createProduct({
      organizationId: organization.id,
      sku: "SKU-ARCHIVE",
      name: "To archive",
      defaultUnitsPerBox: 1,
      barcodes: [],
      actorUserId: user.id,
    });

    const archived = await archiveProduct({
      organizationId: organization.id,
      productId: product.id,
      actorUserId: user.id,
    });

    expect(archived.active).toBe(false);
    expect(archived.archivedAt).not.toBeNull();

    const stillExists = await prisma.product.findUnique({ where: { id: product.id } });
    expect(stillExists).not.toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: { organizationId: organization.id, entityType: "Product", entityId: product.id, action: "product.archived" },
    });
    expect(audit).not.toBeNull();
  });

  it("searchProducts exact mode returns SKU and EAN exact matches, never mixed with suggestions", async () => {
    const { organization, user } = await makeOrgUser();
    const { product: bySku } = await createProduct({
      organizationId: organization.id,
      sku: "SKU-EXACT-1",
      name: "Exact by SKU",
      defaultUnitsPerBox: 1,
      barcodes: [],
      actorUserId: user.id,
    });
    const { product: byEan } = await createProduct({
      organizationId: organization.id,
      sku: "SKU-EXACT-2",
      name: "Exact by EAN",
      defaultUnitsPerBox: 1,
      barcodes: [{ value: VALID_EAN13, type: "EAN13" }],
      actorUserId: user.id,
    });

    const skuResult = await searchProducts({ organizationId: organization.id, query: "SKU-EXACT-1", mode: "exact" });
    expect(skuResult.exactMatches).toHaveLength(1);
    expect(skuResult.exactMatches[0].matchType).toBe("SKU");
    expect(skuResult.exactMatches[0].product?.id).toBe(bySku.id);

    const eanResult = await searchProducts({ organizationId: organization.id, query: VALID_EAN13, mode: "exact" });
    expect(eanResult.exactMatches).toHaveLength(1);
    expect(eanResult.exactMatches[0].matchType).toBe("EAN");
    expect(eanResult.exactMatches[0].product?.id).toBe(byEan.id);
  });

  it("searchProducts exact mode does not correct visually ambiguous characters (O/0)", async () => {
    const { organization, user } = await makeOrgUser();
    await createProduct({
      organizationId: organization.id,
      sku: "SKU-O01",
      name: "Letter O variant",
      defaultUnitsPerBox: 1,
      barcodes: [],
      actorUserId: user.id,
    });

    const result = await searchProducts({ organizationId: organization.id, query: "SKU-001", mode: "exact" });
    expect(result.exactMatches).toHaveLength(0);
  });

  it("searchProducts name mode returns suggestions, clearly separate from exact matches", async () => {
    const { organization, user } = await makeOrgUser();
    await createProduct({
      organizationId: organization.id,
      sku: "SKU-NAME-1",
      name: "Chocolate Bar Deluxe",
      category: "Snacks",
      defaultUnitsPerBox: 1,
      barcodes: [],
      actorUserId: user.id,
    });

    const result = await searchProducts({ organizationId: organization.id, query: "Chocolate", mode: "name" });
    expect(result).not.toHaveProperty("exactMatches");
    expect(result.suggestions?.length).toBeGreaterThan(0);
  });

  it("searchProducts prefix mode matches on SKU prefix", async () => {
    const { organization, user } = await makeOrgUser();
    const { product } = await createProduct({
      organizationId: organization.id,
      sku: "PFX-0001",
      name: "Prefix product",
      defaultUnitsPerBox: 1,
      barcodes: [],
      actorUserId: user.id,
    });

    const result = await searchProducts({ organizationId: organization.id, query: "PFX-", mode: "prefix" });
    expect(result.products?.map((p) => p.id)).toContain(product.id);
  });

  it("getProductLookup returns the exact product for a scanned EAN or SKU", async () => {
    const { organization, user } = await makeOrgUser();
    const { product } = await createProduct({
      organizationId: organization.id,
      sku: "SKU-LOOKUP",
      name: "Lookup target",
      defaultUnitsPerBox: 1,
      barcodes: [{ value: VALID_EAN13, type: "EAN13" }],
      actorUserId: user.id,
    });

    const bySku = await getProductLookup({ organizationId: organization.id, code: "SKU-LOOKUP" });
    expect(bySku.id).toBe(product.id);

    const byEan = await getProductLookup({ organizationId: organization.id, code: VALID_EAN13 });
    expect(byEan.id).toBe(product.id);
  });

  it("getProductLookup throws PRODUCT_NOT_FOUND for a code with no exact match", async () => {
    const { organization } = await makeOrgUser();

    await expect(
      getProductLookup({ organizationId: organization.id, code: "NO-SUCH-CODE" }),
    ).rejects.toMatchObject({ code: "PRODUCT_NOT_FOUND" });
  });
});
