import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logging";

const env = getEnv();

/**
 * Database-backed session auth. Public self-registration is disabled
 * (`disableSignUp`) — accounts are only created through the invitation-accept
 * flow in `server/services/invitations.ts`, which creates the User/Account
 * rows directly and then signs in, deliberately bypassing this public
 * sign-up endpoint rather than relying on it.
 */
export const auth = betterAuth({
  secret: env.AUTH_SECRET,
  baseURL: env.APP_URL,
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 12,
    sendResetPassword: async ({ user, url }) => {
      // No transactional email provider is wired up yet (EMAIL_PROVIDER=console
      // in every environment so far). Logging the reset link keeps the reset
      // flow fully functional in development without inventing a fake send.
      logger.info({ email: user.email, url }, "password_reset_link_generated");
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 14, // 14 days
    updateAge: 60 * 60 * 24, // rotate session expiry once a day of activity
  },
  advanced: {
    useSecureCookies: env.NODE_ENV === "production",
  },
  plugins: [nextCookies()],
});

export type AppSession = typeof auth.$Infer.Session;
