import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";

/**
 * Creates a real Organization + User + Membership row in the test database
 * (arachnet_test) for integration tests that need a genuine organizationId /
 * userId pair rather than a mock. Every field uses a random suffix so
 * parallel test runs never collide on the unique `slug`/`email` columns.
 */
export async function createTestOrgAndUser(role: "OWNER" | "ADMIN" | "MANAGER" | "COUNTER" | "VIEWER" = "COUNTER") {
  const suffix = randomUUID();

  const organization = await prisma.organization.create({
    data: {
      name: `Test Org ${suffix}`,
      slug: `test-org-${suffix}`,
    },
  });

  const user = await prisma.user.create({
    data: {
      email: `test-user-${suffix}@example.test`,
      name: `Test User ${suffix}`,
      emailVerified: true,
    },
  });

  const membership = await prisma.membership.create({
    data: {
      organizationId: organization.id,
      userId: user.id,
      role,
    },
  });

  return { organization, user, membership };
}
