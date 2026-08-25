import "dotenv/config";
import { hashPassword } from "better-auth/crypto";
import { prisma } from "@/lib/prisma";
import { E2E_ORG_SLUG, E2E_OWNER_EMAIL, E2E_OWNER_PASSWORD } from "./constants";

/**
 * Creates (or reuses) a dedicated E2E organization + owner user with a fixed
 * password, separate from prisma/seed.ts's demo data (which generates a
 * random one-time password not retrievable by an automated test).
 *
 * Run standalone via `npx tsx tests/e2e/seed-e2e-user.ts` (wired into
 * `pnpm test:e2e` ahead of `playwright test`) rather than as a Playwright
 * `globalSetup` — Playwright's own TS runner can't load this module because
 * it imports `@/lib/prisma`, which imports the Prisma 7 generated client,
 * which is ESM-only (`import.meta`) and fails under Playwright's CJS-ish
 * config-loading context. Running it as a plain tsx script first sidesteps
 * that entirely.
 */
async function main() {
  const organization = await prisma.organization.upsert({
    where: { slug: E2E_ORG_SLUG },
    update: {},
    create: { name: "Organización E2E", slug: E2E_ORG_SLUG, timezone: "UTC", locale: "es" },
  });

  let user = await prisma.user.findUnique({ where: { email: E2E_OWNER_EMAIL } });
  if (!user) {
    user = await prisma.user.create({
      data: { email: E2E_OWNER_EMAIL, name: "Propietario E2E", emailVerified: true },
    });
  }

  const existingAccount = await prisma.account.findFirst({
    where: { userId: user.id, providerId: "credential" },
  });
  if (!existingAccount) {
    await prisma.account.create({
      data: {
        userId: user.id,
        accountId: user.id,
        providerId: "credential",
        issuer: "local:credential",
        password: await hashPassword(E2E_OWNER_PASSWORD),
      },
    });
  }

  await prisma.membership.upsert({
    where: { organizationId_userId: { organizationId: organization.id, userId: user.id } },
    update: { role: "OWNER" },
    create: { organizationId: organization.id, userId: user.id, role: "OWNER" },
  });

  console.log(`E2E fixture ready: ${E2E_OWNER_EMAIL}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
