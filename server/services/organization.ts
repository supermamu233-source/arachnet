import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/errors";
import { recordAudit } from "@/server/services/audit";
import type { Role } from "@/server/permissions/rbac";

export async function getOrganization(organizationId: string) {
  return prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
}

export async function updateOrganization(params: {
  organizationId: string;
  actorUserId: string;
  name?: string;
  timezone?: string;
  locale?: string;
}) {
  const before = await prisma.organization.findUniqueOrThrow({ where: { id: params.organizationId } });
  const updated = await prisma.organization.update({
    where: { id: params.organizationId },
    data: { name: params.name, timezone: params.timezone, locale: params.locale },
  });
  await recordAudit({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    action: "organization.updated",
    entityType: "Organization",
    entityId: params.organizationId,
    oldValue: { name: before.name, timezone: before.timezone, locale: before.locale },
    newValue: { name: updated.name, timezone: updated.timezone, locale: updated.locale },
  });
  return updated;
}

export async function listMembers(organizationId: string) {
  return prisma.membership.findMany({
    where: { organizationId },
    include: { user: { select: { id: true, name: true, email: true, createdAt: true } } },
    orderBy: { createdAt: "asc" },
  });
}

export async function updateMemberRole(params: {
  organizationId: string;
  membershipId: string;
  role: Role;
  actorUserId: string;
}) {
  const membership = await prisma.membership.findUnique({ where: { id: params.membershipId } });
  if (!membership || membership.organizationId !== params.organizationId) {
    throw new ApiError("NOT_FOUND", "Membership not found.");
  }
  if (membership.userId === params.actorUserId && membership.role === "OWNER" && params.role !== "OWNER") {
    throw new ApiError("CONFLICT", "You cannot demote your own OWNER membership.");
  }
  const updated = await prisma.membership.update({
    where: { id: params.membershipId },
    data: { role: params.role },
  });
  await recordAudit({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    action: "membership.role_changed",
    entityType: "Membership",
    entityId: membership.id,
    oldValue: { role: membership.role },
    newValue: { role: params.role },
  });
  return updated;
}

export async function removeMember(params: { organizationId: string; membershipId: string; actorUserId: string }) {
  const membership = await prisma.membership.findUnique({ where: { id: params.membershipId } });
  if (!membership || membership.organizationId !== params.organizationId) {
    throw new ApiError("NOT_FOUND", "Membership not found.");
  }
  if (membership.userId === params.actorUserId) {
    throw new ApiError("CONFLICT", "You cannot remove your own membership.");
  }
  await prisma.membership.delete({ where: { id: membership.id } });
  await recordAudit({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    action: "membership.removed",
    entityType: "Membership",
    entityId: membership.id,
    oldValue: { role: membership.role, userId: membership.userId },
  });
}

export async function listAuditLog(params: {
  organizationId: string;
  entityType?: string;
  take?: number;
}) {
  return prisma.auditLog.findMany({
    where: {
      organizationId: params.organizationId,
      ...(params.entityType ? { entityType: params.entityType } : {}),
    },
    include: { actorUser: { select: { name: true, email: true } } },
    orderBy: { createdAt: "desc" },
    take: params.take ?? 200,
  });
}
