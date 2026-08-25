import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createWarehouse } from "@/server/services/warehouses";
import {
  createLocation,
  getLocationWithAncestors,
  listLocations,
  updateLocation,
} from "@/server/services/locations";
import { createTestOrgAndUser } from "@/tests/integration/helpers";

describe("locations service", () => {
  const createdOrganizationIds: string[] = [];

  afterAll(async () => {
    if (createdOrganizationIds.length > 0) {
      await prisma.organization.deleteMany({ where: { id: { in: createdOrganizationIds } } });
    }
    await prisma.$disconnect();
  });

  async function makeOrgWithWarehouse(role: "OWNER" | "ADMIN" | "MANAGER" | "COUNTER" | "VIEWER" = "MANAGER") {
    const { organization, user } = await createTestOrgAndUser(role);
    createdOrganizationIds.push(organization.id);
    const warehouse = await createWarehouse({
      organizationId: organization.id,
      name: "Test warehouse",
      code: `WH-${randomUUID().slice(0, 8)}`,
      actorUserId: user.id,
    });
    return { organization, user, warehouse };
  }

  it("creates a root location and records an audit entry", async () => {
    const { organization, user, warehouse } = await makeOrgWithWarehouse();

    const location = await createLocation({
      organizationId: organization.id,
      warehouseId: warehouse.id,
      code: "A01",
      name: "Zone A",
      type: "ZONE",
      actorUserId: user.id,
    });

    expect(location.code).toBe("A01");
    expect(location.parentId).toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: { organizationId: organization.id, entityType: "Location", entityId: location.id },
    });
    expect(audit?.action).toBe("location.created");
  });

  it("creates a child location under a parent in the same warehouse", async () => {
    const { organization, user, warehouse } = await makeOrgWithWarehouse();

    const parent = await createLocation({
      organizationId: organization.id,
      warehouseId: warehouse.id,
      code: "A02",
      name: "Zone A2",
      type: "ZONE",
      actorUserId: user.id,
    });

    const child = await createLocation({
      organizationId: organization.id,
      warehouseId: warehouse.id,
      parentId: parent.id,
      code: "A02-01",
      name: "Aisle 1",
      type: "AISLE",
      actorUserId: user.id,
    });

    expect(child.parentId).toBe(parent.id);
  });

  it("rejects a parent that belongs to a different warehouse in the same org", async () => {
    const { organization, user, warehouse } = await makeOrgWithWarehouse();
    const otherWarehouse = await createWarehouse({
      organizationId: organization.id,
      name: "Other warehouse",
      code: `WH-${randomUUID().slice(0, 8)}`,
      actorUserId: user.id,
    });

    const parentInOtherWarehouse = await createLocation({
      organizationId: organization.id,
      warehouseId: otherWarehouse.id,
      code: "B01",
      name: "Zone B",
      type: "ZONE",
      actorUserId: user.id,
    });

    await expect(
      createLocation({
        organizationId: organization.id,
        warehouseId: warehouse.id,
        parentId: parentInOtherWarehouse.id,
        code: "A03-01",
        name: "Aisle mismatch",
        type: "AISLE",
        actorUserId: user.id,
      }),
    ).rejects.toMatchObject({ code: "LOCATION_NOT_FOUND" });
  });

  it("rejects a parent that belongs to a different organization", async () => {
    const { organization, user, warehouse } = await makeOrgWithWarehouse();
    const otherOrg = await makeOrgWithWarehouse();

    const parentInOtherOrg = await createLocation({
      organizationId: otherOrg.organization.id,
      warehouseId: otherOrg.warehouse.id,
      code: "C01",
      name: "Zone C",
      type: "ZONE",
      actorUserId: otherOrg.user.id,
    });

    await expect(
      createLocation({
        organizationId: organization.id,
        warehouseId: warehouse.id,
        parentId: parentInOtherOrg.id,
        code: "A04-01",
        name: "Aisle cross-org",
        type: "AISLE",
        actorUserId: user.id,
      }),
    ).rejects.toMatchObject({ code: "ORGANIZATION_MISMATCH" });
  });

  it("rejects a nonexistent parentId with LOCATION_NOT_FOUND", async () => {
    const { organization, user, warehouse } = await makeOrgWithWarehouse();

    await expect(
      createLocation({
        organizationId: organization.id,
        warehouseId: warehouse.id,
        parentId: "does-not-exist",
        code: "A05-01",
        name: "Aisle orphan",
        type: "AISLE",
        actorUserId: user.id,
      }),
    ).rejects.toMatchObject({ code: "LOCATION_NOT_FOUND" });
  });

  it("rejects a duplicate [warehouseId, code] with CONFLICT", async () => {
    const { organization, user, warehouse } = await makeOrgWithWarehouse();

    await createLocation({
      organizationId: organization.id,
      warehouseId: warehouse.id,
      code: "DUP",
      name: "First",
      type: "ZONE",
      actorUserId: user.id,
    });

    await expect(
      createLocation({
        organizationId: organization.id,
        warehouseId: warehouse.id,
        code: "DUP",
        name: "Second",
        type: "ZONE",
        actorUserId: user.id,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("walks the ancestor chain root-first, ending with the requested location", async () => {
    const { organization, user, warehouse } = await makeOrgWithWarehouse();

    const zone = await createLocation({
      organizationId: organization.id,
      warehouseId: warehouse.id,
      code: "Z1",
      name: "Zone 1",
      type: "ZONE",
      actorUserId: user.id,
    });
    const aisle = await createLocation({
      organizationId: organization.id,
      warehouseId: warehouse.id,
      parentId: zone.id,
      code: "Z1-A1",
      name: "Aisle 1",
      type: "AISLE",
      actorUserId: user.id,
    });
    const rack = await createLocation({
      organizationId: organization.id,
      warehouseId: warehouse.id,
      parentId: aisle.id,
      code: "Z1-A1-R1",
      name: "Rack 1",
      type: "RACK",
      actorUserId: user.id,
    });

    const chain = await getLocationWithAncestors(organization.id, rack.id);
    expect(chain.map((l) => l.id)).toEqual([zone.id, aisle.id, rack.id]);
  });

  it("throws LOCATION_NOT_FOUND for a location belonging to a different organization", async () => {
    const { organization, warehouse, user } = await makeOrgWithWarehouse();
    const otherOrg = await createTestOrgAndUser("MANAGER");
    createdOrganizationIds.push(otherOrg.organization.id);

    const location = await createLocation({
      organizationId: organization.id,
      warehouseId: warehouse.id,
      code: "Z2",
      name: "Zone 2",
      type: "ZONE",
      actorUserId: user.id,
    });

    await expect(getLocationWithAncestors(otherOrg.organization.id, location.id)).rejects.toMatchObject({
      code: "LOCATION_NOT_FOUND",
    });
  });

  it("updates a location's name and can archive it (active:false, never deleted)", async () => {
    const { organization, user, warehouse } = await makeOrgWithWarehouse();

    const location = await createLocation({
      organizationId: organization.id,
      warehouseId: warehouse.id,
      code: "Z3",
      name: "Zone 3",
      type: "ZONE",
      actorUserId: user.id,
    });

    const renamed = await updateLocation({
      organizationId: organization.id,
      locationId: location.id,
      actorUserId: user.id,
      name: "Zone 3 renamed",
    });
    expect(renamed.name).toBe("Zone 3 renamed");
    expect(renamed.active).toBe(true);

    const archived = await updateLocation({
      organizationId: organization.id,
      locationId: location.id,
      actorUserId: user.id,
      active: false,
    });
    expect(archived.active).toBe(false);

    const stillExists = await prisma.location.findUnique({ where: { id: location.id } });
    expect(stillExists).not.toBeNull();
  });

  it("lists only locations for the given warehouse when warehouseId is provided", async () => {
    const { organization, user, warehouse } = await makeOrgWithWarehouse();
    const otherWarehouse = await createWarehouse({
      organizationId: organization.id,
      name: "Other",
      code: `WH-${randomUUID().slice(0, 8)}`,
      actorUserId: user.id,
    });

    const inTarget = await createLocation({
      organizationId: organization.id,
      warehouseId: warehouse.id,
      code: "T1",
      name: "In target",
      type: "ZONE",
      actorUserId: user.id,
    });
    await createLocation({
      organizationId: organization.id,
      warehouseId: otherWarehouse.id,
      code: "T1",
      name: "In other",
      type: "ZONE",
      actorUserId: user.id,
    });

    const list = await listLocations({ organizationId: organization.id, warehouseId: warehouse.id });
    expect(list.map((l) => l.id)).toEqual([inTarget.id]);
  });
});
