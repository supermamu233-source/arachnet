import { prisma } from "@/lib/prisma";

async function main() {
  const barcode = "5056561803944";

  const product = await prisma.product.findFirst({
    where: { sku: "SKU-0001" },
  });

  if (!product) {
    throw new Error("SKU-0001 not found");
  }

  const location = await prisma.location.findFirst({
    where: { code: "WH1-A03-RB-L04" },
  });

  if (!location) {
    throw new Error("WH1-A03-RB-L04 not found");
  }

  const existing = await prisma.productBarcode.findFirst({
    where: {
      organizationId: product.organizationId,
      value: barcode,
    },
  });

  if (existing && existing.productId !== product.id) {
    throw new Error(
      `Barcode ${barcode} already belongs to another product`
    );
  }

  await prisma.productBarcode.upsert({
    where: {
      organizationId_value: {
        organizationId: product.organizationId,
        value: barcode,
      },
    },
    update: {
      productId: product.id,
      type: "EAN13",
    },
    create: {
      organizationId: product.organizationId,
      productId: product.id,
      value: barcode,
      type: "EAN13",
      isPrimary: false,
    },
  });

  const expected = await prisma.expectedStockBalance.findFirst({
    where: {
      organizationId: product.organizationId,
      productId: product.id,
      locationId: location.id,
    },
    orderBy: {
      sourceUpdatedAt: "desc",
    },
  });

  console.log({
    product: product.name,
    sku: product.sku,
    barcode,
    location: location.code,
    unitsPerBox: product.defaultUnitsPerBox,
    expectedQuantity: expected?.quantity ?? null,
  });
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
