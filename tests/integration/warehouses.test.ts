import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createWarehouse, listWarehouses } from "@/server/services/warehouses";
import { createTestOrgAndUser } from "@/tests/integration/helpers";

describe("createWarehouse / listWarehouses", () => {
  const createdOrganizationIds: string[] = [];

  afterAll(async () => {
    if (createdOrganizationIds.length > 0) {
      await prisma.organization.deleteMany({ where: { id: { in: createdOrganizationIds } } });
    }
    await prisma.$disconnect();
  });

  async function makeOrgUser(role: "OWNER" | "ADMIN" | "MANAGER" | "COUNTER" | "VIEWER" = "ADMIN") {
    const { organization, user } = await createTestOrgAndUser(role);
    createdOrganizationIds.push(organization.id);
    return { organization, user };
  }

  it("creates a warehouse and records an audit entry", async () => {
    const { organization, user } = await makeOrgUser();
    const code = `WH-${randomUUID().slice(0, 8)}`;

    const warehouse = await createWarehouse({
      organizationId: organization.id,
      name: "Main warehouse",
      code,
      actorUserId: user.id,
    });

    expect(warehouse.code).toBe(code);
    expect(warehouse.organizationId).toBe(organization.id);

    const audit = await prisma.auditLog.findFirst({
      where: { organizationId: organization.id, entityType: "Warehouse", entityId: warehouse.id },
    });
    expect(audit).not.toBeNull();
    expect(audit?.action).toBe("warehouse.created");
    expect(audit?.actorUserId).toBe(user.id);
  });

  it("rejects a duplicate [organizationId, code] with CONFLICT", async () => {
    const { organization, user } = await makeOrgUser();
    const code = `WH-${randomUUID().slice(0, 8)}`;

    await createWarehouse({ organizationId: organization.id, name: "First", code, actorUserId: user.id });

    await expect(
      createWarehouse({ organizationId: organization.id, name: "Second", code, actorUserId: user.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("allows the same code across two different organizations", async () => {
    const orgA = await makeOrgUser();
    const orgB = await makeOrgUser();
    const code = `WH-${randomUUID().slice(0, 8)}`;

    await expect(
      createWarehouse({ organizationId: orgA.organization.id, name: "A", code, actorUserId: orgA.user.id }),
    ).resolves.toMatchObject({ code });
    await expect(
      createWarehouse({ organizationId: orgB.organization.id, name: "B", code, actorUserId: orgB.user.id }),
    ).resolves.toMatchObject({ code });
  });

  it("only lists warehouses belonging to the given organization", async () => {
    const orgA = await makeOrgUser();
    const orgB = await makeOrgUser();

    const warehouseA = await createWarehouse({
      organizationId: orgA.organization.id,
      name: "A",
      code: `WH-${randomUUID().slice(0, 8)}`,
      actorUserId: orgA.user.id,
    });
    await createWarehouse({
      organizationId: orgB.organization.id,
      name: "B",
      code: `WH-${randomUUID().slice(0, 8)}`,
      actorUserId: orgB.user.id,
    });

    const list = await listWarehouses(orgA.organization.id);
    expect(list.map((w) => w.id)).toEqual([warehouseA.id]);
  });
});
