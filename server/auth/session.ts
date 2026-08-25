import { cookies as nextCookies, headers as nextHeaders } from "next/headers";
import { auth } from "@/server/auth/auth";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/errors";
import { roleSatisfies, type Role } from "@/server/permissions/rbac";

export interface AuthContext {
  userId: string;
  email: string;
  name: string;
  organizationId: string;
  role: Role;
  membershipId: string;
}

/** Cookie recording which organization the user last selected, for users
 * with more than one membership. Not a security boundary by itself — every
 * route still re-derives and re-checks the membership row server-side. */
export const ACTIVE_ORG_COOKIE = "arachnet_active_org";

/**
 * Resolves the current user's session and active-organization membership, or
 * null if there is no session or the user has no memberships at all. This is
 * the one place that turns a better-auth session into an Arachnet
 * organization + role context — every organization-scoped query in the app
 * should be built from the `organizationId` this returns, never from a
 * client-supplied value.
 */
export async function getAuthContext(): Promise<AuthContext | null> {
  const hdrs = await nextHeaders();
  const session = await auth.api.getSession({ headers: hdrs });
  if (!session) return null;

  const memberships = await prisma.membership.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "asc" },
  });
  if (memberships.length === 0) return null;

  const cookieStore = await nextCookies();
  const requestedOrgId = cookieStore.get(ACTIVE_ORG_COOKIE)?.value;

  const membership =
    (requestedOrgId ? memberships.find((m) => m.organizationId === requestedOrgId) : undefined) ??
    memberships[0];

  return {
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name,
    organizationId: membership.organizationId,
    role: membership.role,
    membershipId: membership.id,
  };
}

/** Same as {@link getAuthContext}, but throws a 401 ApiError instead of
 * returning null. Use in every route handler and server action that requires
 * a signed-in user. */
export async function requireAuthContext(): Promise<AuthContext> {
  const context = await getAuthContext();
  if (!context) {
    throw new ApiError("UNAUTHENTICATED", "Authentication required.");
  }
  return context;
}

/** Requires a session AND that the active membership's role satisfies the
 * given minimum (per the OWNER > ADMIN > MANAGER > COUNTER > VIEWER
 * hierarchy). Throws 401 if unauthenticated, 403 if under-privileged. */
export async function requireRole(minimum: Role): Promise<AuthContext> {
  const context = await requireAuthContext();
  if (!roleSatisfies(context.role, minimum)) {
    throw new ApiError("FORBIDDEN", `This action requires the ${minimum} role or higher.`);
  }
  return context;
}

/** Asserts that a resource's own organizationId matches the caller's active
 * organization. Always call this before returning or mutating any row looked
 * up by id, so a guessed/leaked id from another tenant cannot be read. */
export function assertSameOrganization(context: AuthContext, resourceOrganizationId: string) {
  if (context.organizationId !== resourceOrganizationId) {
    throw new ApiError("ORGANIZATION_MISMATCH", "Resource does not belong to this organization.");
  }
}
