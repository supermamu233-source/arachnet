import { test, expect } from "@playwright/test";
import { loginAsOwner, uniqueSuffix } from "./helpers";

test.describe.serial("warehouse / location / product setup", () => {
  const suffix = uniqueSuffix();
  const warehouseCode = `E2E-WH-${suffix}`;
  const warehouseName = `Almacén E2E ${suffix}`;
  const locationCode = `${warehouseCode}-A01`;
  const productSku = `E2E-SKU-${suffix}`;

  test.beforeEach(async ({ page }) => {
    await loginAsOwner(page);
  });

  test("logs in and reaches the dashboard", async ({ page }) => {
    await expect(page.getByText("Discrepancias abiertas")).toBeVisible();
  });

  test("creates a warehouse", async ({ page }) => {
    await page.goto("/settings/warehouses");
    await page.getByRole("button", { name: "Nuevo almacén" }).click();
    await page.getByLabel("Nombre").fill(warehouseName);
    await page.getByLabel("Código").fill(warehouseCode);
    await page.getByRole("button", { name: "Crear" }).click();
    await expect(page.getByText(warehouseCode)).toBeVisible();
  });

  test("creates a location under the new warehouse", async ({ page }) => {
    await page.goto("/locations");
    await page.getByRole("button", { name: "Nueva ubicación" }).click();

    // The warehouse Select is populated from /api/warehouses — pick the one
    // just created by code rather than assuming ordering.
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: new RegExp(warehouseCode) }).click();

    await page.getByLabel("Código").fill(locationCode);
    await page.getByLabel("Nombre").fill(`Zona A ${suffix}`);
    await page.getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByText(locationCode)).toBeVisible();
  });

  test("creates a product", async ({ page }) => {
    await page.goto("/products");
    await page.getByRole("button", { name: "Nuevo producto" }).click();
    await page.getByLabel("SKU").fill(productSku);
    await page.getByLabel("Nombre").fill(`Producto E2E ${suffix}`);
    await page.getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByText(productSku)).toBeVisible();
  });
});
