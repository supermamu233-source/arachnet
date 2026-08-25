import { z } from "zod";
import { ok, toErrorResponse } from "@/lib/errors";
import { newRequestId } from "@/lib/request-id";
import { auth } from "@/server/auth/auth";
import { acceptInvitation } from "@/server/services/invitations";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/errors";

const acceptSchema = z.object({
  name: z.string().min(1).max(200),
  password: z.string().min(12).max(200),
});

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const requestId = newRequestId();
  try {
    const { token } = await params;
    const invitation = await prisma.invitation.findUnique({
      where: { token },
      select: { email: true, role: true, status: true, expiresAt: true, organization: { select: { name: true } } },
    });
    if (!invitation) throw new ApiError("NOT_FOUND", "Invitation not found.");
    return ok(invitation, requestId);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const requestId = newRequestId();
  try {
    const { token } = await params;
    const body = acceptSchema.parse(await request.json());

    const { user } = await acceptInvitation({ token, name: body.name, password: body.password });

    // Establish a real session (sets the httpOnly cookie via the nextCookies
    // plugin, since this executes inside a Route Handler) rather than making
    // the client immediately call the sign-in endpoint separately.
    await auth.api.signInEmail({
      body: { email: user.email, password: body.password },
      asResponse: false,
    });

    return ok({ email: user.email }, requestId, { status: 201 });
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
