import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { getEnv } from "@/lib/env";

declare global {
  var __prisma: PrismaClient | undefined;
}

function createPrismaClient() {
  const env = getEnv();
  const adapter = new PrismaPg(env.DATABASE_URL);
  return new PrismaClient({ adapter });
}

// Reuse a single client across hot reloads in development so we don't exhaust
// the Postgres connection pool.
export const prisma = globalThis.__prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__prisma = prisma;
}
