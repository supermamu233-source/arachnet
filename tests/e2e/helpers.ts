import type { Page } from "@playwright/test";
import { E2E_OWNER_EMAIL, E2E_OWNER_PASSWORD } from "./constants";

export function uniqueSuffix(): string {
  return Date.now().toString(36);
}

export async function loginAsOwner(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Correo electrónico").fill(E2E_OWNER_EMAIL);
  await page.getByLabel("Contraseña", { exact: true }).fill(E2E_OWNER_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL("**/dashboard");
}
