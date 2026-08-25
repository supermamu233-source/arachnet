import { randomBytes } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/errors";
import { recordAudit } from "@/server/services/audit";
import type { Role } from "@/server/permissions/rbac";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CreateInvitationParams {
  organizationId: string;
  email: string;
  role: Role;
  invitedById: string;
}

/**
 * Arachnet is invite-only (see product principle 2.1 / section 8): there is
 * no public sign-up. This is the only path that produces a usable account —
 * see acceptInvitation below, which creates the User/Account rows directly
 * rather than going through better-auth's (disabled) public sign-up endpoint.
 */
export async function createInvitation(params: CreateInvitationParams) {
  const existingMembership = await prisma.membership.findFirst({
    where: { organizationId: params.organizationId, user: { email: params.email } },
  });
  if (existingMembership) {
    throw new ApiError("CONFLICT", "This email is already a member of the organization.");
  }

  const token = randomBytes(32).toString("hex");
  const invitation = await prisma.invitation.create({
    data: {
      organizationId: params.organizationId,
      email: params.email,
      role: params.role,
      token,
      invitedById: params.invitedById,
      expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
    },
  });

  await recordAudit({
    organizationId: params.organizationId,
    actorUserId: params.invitedById,
    action: "invitation.created",
    entityType: "Invitation",
    entityId: invitation.id,
    newValue: { email: params.email, role: params.role },
  });

  return invitation;
}

interface AcceptInvitationParams {
  token: string;
  name: string;
  password: string;
}

export async function acceptInvitation(params: AcceptInvitationParams) {
  const invitation = await prisma.invitation.findUnique({ where: { token: params.token } });
  if (!invitation) {
    throw new ApiError("NOT_FOUND", "Invitation not found.");
  }
  if (invitation.status !== "PENDING") {
    throw new ApiError("CONFLICT", "This invitation has already been used or revoked.");
  }
  if (invitation.expiresAt.getTime() < Date.now()) {
    await prisma.invitation.update({ where: { id: invitation.id }, data: { status: "EXPIRED" } });
    throw new ApiError("CONFLICT", "This invitation has expired.");
  }

  const passwordHash = await hashPassword(params.password);

  const user = await prisma.$transaction(async (tx) => {
    const existingUser = await tx.user.findUnique({ where: { email: invitation.email } });

    const createdUser =
      existingUser ??
      (await tx.user.create({
        data: { email: invitation.email, name: params.name, emailVerified: true },
      }));

    if (existingUser) {
      const existingAccount = await tx.account.findFirst({
        where: { userId: existingUser.id, providerId: "credential" },
      });
      if (existingAccount) {
        throw new ApiError("CONFLICT", "An account with this email already exists.");
      }
    }

    await tx.account.create({
      data: {
        userId: createdUser.id,
        accountId: createdUser.id,
        providerId: "credential",
        password: passwordHash,
      },
    });

    await tx.membership.create({
      data: {
        organizationId: invitation.organizationId,
        userId: createdUser.id,
        role: invitation.role,
      },
    });

    await tx.invitation.update({
      where: { id: invitation.id },
      data: { status: "ACCEPTED", acceptedAt: new Date() },
    });

    await recordAudit(
      {
        organizationId: invitation.organizationId,
        actorUserId: createdUser.id,
        action: "invitation.accepted",
        entityType: "Membership",
        entityId: createdUser.id,
        newValue: { role: invitation.role },
      },
      tx,
    );

    return createdUser;
  });

  return { user, organizationId: invitation.organizationId };
}
