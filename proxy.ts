import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

const PUBLIC_PATHS = ["/login", "/forgot-password", "/reset-password", "/invitations"];

/**
 * Fast, cookie-presence-only gate for the dashboard shell. This is not the
 * security boundary — it only avoids rendering an authenticated shell for an
 * obviously signed-out browser. Every route handler and server component
 * still calls requireAuthContext()/requireRole() (server/auth/session.ts),
 * which re-validates the session against the database on every request.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isPublic =
    PUBLIC_PATHS.some((path) => pathname.startsWith(path)) ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/invitations") ||
    pathname.startsWith("/api/robot") ||
    pathname === "/api/health" ||
    pathname === "/api/ready";

  if (isPublic) return NextResponse.next();

  const sessionCookie = getSessionCookie(request);
  if (!sessionCookie && pathname.startsWith("/api/")) {
    return NextResponse.json(
      { data: null, error: { code: "UNAUTHENTICATED", message: "Authentication required." }, requestId: null },
      { status: 401 },
    );
  }
  if (!sessionCookie) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("from", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
