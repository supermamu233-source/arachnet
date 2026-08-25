import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { requireRole } from "@/server/auth/session";
import { createInvitation } from "@/server/services/invitations";

const createSchema = z.object({
  email: z.email(),
  role: z.enum(["ADMIN", "MANAGER", "COUNTER", "VIEWER"]),
});

export async function GET() {
  const requestId = newRequestId();
  try {
    const context = await requireRole("ADMIN");
    const invitations = await prisma.invitation.findMany({
      where: { organizationId: context.organizationId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        expiresAt: true,
        acceptedAt: true,
        createdAt: true,
      },
    });
    return ok(invitations, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}

export async function POST(request: Request) {
  const requestId = newRequestId();
  try {
    const context = await requireRole("ADMIN");
    const body = createSchema.parse(await request.json());

    const invitation = await createInvitation({
      organizationId: context.organizationId,
      email: body.email,
      role: body.role,
      invitedById: context.userId,
    });

    return ok(
      { id: invitation.id, email: invitation.email, role: invitation.role, token: invitation.token },
      requestId,
      { status: 201 },
    );
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
