import "dotenv/config";
import { randomBytes } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { prisma } from "@/lib/prisma";

const ORG_SLUG = "demo-warehouse";
const WAREHOUSE_CODE = "WH1";
const ROBOT_CASE_EAN = "8431234567890";
const ROBOT_CASE_LOCATION_CODE = "WH1-A03-RB-L04";

async function main() {
  console.log("Seeding Arachnet demo data...");

  const organization = await prisma.organization.upsert({
    where: { slug: ORG_SLUG },
    update: {},
    create: {
      name: "Almacén Demo Arachnet",
      slug: ORG_SLUG,
      timezone: "Australia/Sydney",
      locale: "es",
    },
  });

  const warehouse = await prisma.warehouse.upsert({
    where: { organizationId_code: { organizationId: organization.id, code: WAREHOUSE_CODE } },
    update: {},
    create: {
      organizationId: organization.id,
      name: "Almacén Principal",
      code: WAREHOUSE_CODE,
      address: "123 Demo St, Sydney NSW",
      timezone: "Australia/Sydney",
    },
  });

  // --- Location hierarchy: Warehouse -> Zone -> Aisle -> Rack -> Level ---
  const zone = await prisma.location.upsert({
    where: { warehouseId_code: { warehouseId: warehouse.id, code: "WH1-A" } },
    update: {},
    create: {
      organizationId: organization.id,
      warehouseId: warehouse.id,
      code: "WH1-A",
      name: "Zona A",
      type: "ZONE",
      zone: "A",
    },
  });

  const aisle = await prisma.location.upsert({
    where: { warehouseId_code: { warehouseId: warehouse.id, code: "WH1-A03" } },
    update: {},
    create: {
      organizationId: organization.id,
      warehouseId: warehouse.id,
      parentId: zone.id,
      code: "WH1-A03",
      name: "Pasillo 03",
      type: "AISLE",
      zone: "A",
      aisle: "03",
    },
  });

  const rack = await prisma.location.upsert({
    where: { warehouseId_code: { warehouseId: warehouse.id, code: "WH1-A03-RB" } },
    update: {},
    create: {
      organizationId: organization.id,
      warehouseId: warehouse.id,
      parentId: aisle.id,
      code: "WH1-A03-RB",
      name: "Estantería B",
      type: "RACK",
      zone: "A",
      aisle: "03",
      rack: "RB",
    },
  });

  const level4 = await prisma.location.upsert({
    where: { warehouseId_code: { warehouseId: warehouse.id, code: ROBOT_CASE_LOCATION_CODE } },
    update: {},
    create: {
      organizationId: organization.id,
      warehouseId: warehouse.id,
      parentId: rack.id,
      code: ROBOT_CASE_LOCATION_CODE,
      name: "Nivel 4",
      type: "LEVEL",
      zone: "A",
      aisle: "03",
      rack: "RB",
      level: "04",
    },
  });

  const otherLevels = await Promise.all(
    ["L01", "L02", "L03"].map((suffix, index) =>
      prisma.location.upsert({
        where: { warehouseId_code: { warehouseId: warehouse.id, code: `WH1-A03-RB-${suffix}` } },
        update: {},
        create: {
          organizationId: organization.id,
          warehouseId: warehouse.id,
          parentId: rack.id,
          code: `WH1-A03-RB-${suffix}`,
          name: `Nivel ${index + 1}`,
          type: "LEVEL",
          zone: "A",
          aisle: "03",
          rack: "RB",
          level: String(index + 1).padStart(2, "0"),
        },
      }),
    ),
  );
  const allLevels = [level4, ...otherLevels];

  // --- Manual inventory source (used for seeded expected balances) ---
  const manualSource = await prisma.inventorySource.upsert({
    where: { organizationId_name: { organizationId: organization.id, name: "Entrada manual" } },
    update: {},
    create: { organizationId: organization.id, type: "MANUAL", name: "Entrada manual" },
  });

  // --- Products (20 total, including the exact robot-integration test case) ---
  const categories = ["Bebidas", "Limpieza", "Alimentación", "Ferretería", "Papelería"];
  const brands = ["Norte", "Costa", "Andina", "ElSol", "Rio"];

  const productSeeds = Array.from({ length: 20 }).map((_, index) => {
    const n = index + 1;
    const isRobotCase = n === 1;
    return {
      sku: `SKU-${String(n).padStart(4, "0")}`,
      name: `Producto Demo ${n}`,
      category: categories[n % categories.length],
      brand: brands[n % brands.length],
      defaultUnitsPerBox: isRobotCase ? 6 : [4, 6, 8, 12, 24][n % 5],
      ean: isRobotCase ? ROBOT_CASE_EAN : `84312345${String(6800 + n).padStart(5, "0")}`,
    };
  });

  const products: {
    product: Awaited<ReturnType<typeof prisma.product.upsert>>;
    location: (typeof allLevels)[number];
    seedData: (typeof productSeeds)[number];
  }[] = [];
  for (const seedData of productSeeds) {
    const product = await prisma.product.upsert({
      where: { organizationId_sku: { organizationId: organization.id, sku: seedData.sku } },
      update: {},
      create: {
        organizationId: organization.id,
        sku: seedData.sku,
        name: seedData.name,
        category: seedData.category,
        brand: seedData.brand,
        defaultUnitsPerBox: seedData.defaultUnitsPerBox,
      },
    });
    await prisma.productBarcode.upsert({
      where: { organizationId_value: { organizationId: organization.id, value: seedData.ean } },
      update: {},
      create: {
        organizationId: organization.id,
        productId: product.id,
        value: seedData.ean,
        type: "EAN13",
        isPrimary: true,
      },
    });
    await prisma.packagingRule.upsert({
      where: { id: `${product.id}-default` },
      update: {},
      create: {
        id: `${product.id}-default`,
        productId: product.id,
        name: "Caja estándar",
        packageType: "BOX",
        unitsContained: seedData.defaultUnitsPerBox,
      },
    });
    const location = allLevels[products.length % allLevels.length];
    await prisma.productLocation.upsert({
      where: { productId_locationId: { productId: product.id, locationId: location.id } },
      update: {},
      create: { productId: product.id, locationId: location.id, isPrimary: true },
    });
    products.push({ product, location, seedData });
  }

  const robotCaseProduct = products[0];

  // Expected balance for the required robot integration case: expected = 82
  await prisma.expectedStockBalance.create({
    data: {
      organizationId: organization.id,
      warehouseId: warehouse.id,
      productId: robotCaseProduct.product.id,
      locationId: level4.id,
      sourceId: manualSource.id,
      quantity: 82,
      sourceReference: "seed:robot-integration-case",
      sourceUpdatedAt: new Date(),
    },
  });

  // Expected balances for a handful of other products, so the dashboard and
  // reconciliation views have more than one row to show.
  for (const { product, location } of products.slice(1, 8)) {
    await prisma.expectedStockBalance.create({
      data: {
        organizationId: organization.id,
        warehouseId: warehouse.id,
        productId: product.id,
        locationId: location.id,
        sourceId: manualSource.id,
        quantity: 20 + Math.floor(Math.random() * 60),
        sourceReference: "seed:initial-load",
        sourceUpdatedAt: new Date(),
      },
    });
  }

  // --- Robot device ---
  const robotSecret = randomBytes(24).toString("hex");
  const robotSecretHash = await hashPassword(robotSecret);
  await prisma.robotDevice.upsert({
    where: { organizationId_code: { organizationId: organization.id, code: "scout-001" } },
    update: {},
    create: {
      organizationId: organization.id,
      warehouseId: warehouse.id,
      code: "scout-001",
      name: "Scout 001",
      secretHash: robotSecretHash,
      status: "ACTIVE",
      firmwareVersion: "sim-0.1.0",
    },
  });

  // --- Owner user (bootstrap account; no invitation flow needed for the very
  // first user of a fresh system) ---
  const ownerEmail = "owner@arachnet.local";
  let ownerUser = await prisma.user.findUnique({ where: { email: ownerEmail } });
  let ownerPassword: string | null = null;
  if (!ownerUser) {
    ownerPassword = randomBytes(9).toString("base64url");
    const passwordHash = await hashPassword(ownerPassword);
    ownerUser = await prisma.user.create({
      data: { email: ownerEmail, name: "Propietario Demo", emailVerified: true },
    });
    await prisma.account.create({
      data: {
        userId: ownerUser.id,
        accountId: ownerUser.id,
        providerId: "credential",
        issuer: "local:credential",
        password: passwordHash,
      },
    });
  }
  await prisma.membership.upsert({
    where: { organizationId_userId: { organizationId: organization.id, userId: ownerUser.id } },
    update: {},
    create: { organizationId: organization.id, userId: ownerUser.id, role: "OWNER" },
  });

  console.log("\nSeed complete.");
  console.log(`Organization: ${organization.name} (${organization.slug})`);
  console.log(`Warehouse: ${warehouse.name} (${warehouse.code})`);
  console.log(`Products: ${products.length}`);
  console.log(`Robot device: scout-001`);
  console.log(`  secret (save now, never shown again): ${robotSecret}`);
  if (ownerPassword) {
    console.log(`Owner login: ${ownerEmail}`);
    console.log(`  temporary password (save now, never shown again): ${ownerPassword}`);
  } else {
    console.log(`Owner login: ${ownerEmail} (already existed — password unchanged)`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
